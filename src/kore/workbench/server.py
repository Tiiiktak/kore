#!/usr/bin/env python3
"""kore web server — dashboard + kore session control.

Standalone workbench: the RSI loop/verdict/gate surface has been removed, leaving
only Claude Code session management and the live terminal.

Endpoints:
  GET  /                    the dashboard
  GET  /api/state           lean kore-only view (write policy + roster + liveness)
  GET  /api/health          liveness (open, so `service.sh status` needs no secret)
  GET  /api/kore/policy       the effective kore write policy (allowlist, protections)
  GET  /api/kore/roster       kore sessions; ?scan=cluster sweeps every live node
  GET  /api/kore/read         capture one pane
  GET  /api/kore/stream       the same capture as a live SSE feed (diff frames, ~1s)
  GET  /api/kore/bytes        the same pane as a BYTE stream (tmux control mode, no tick)
  GET  /api/kore/streams      how many SSE feeds are open right now, and the cap
  GET  /api/kore/status       tmux/claude liveness for one session
  GET  /api/kore/jobs         recent write jobs
  GET  /api/kore/job?id=      one write job
  GET  /api/agents          the HTTP-agent registry the bridge routes to (TTL-pruned)
  POST /api/kore/{start,stop,send,keys,input,resize}   drive a kore session; returns a job id
  POST /api/agents/register an agent pushes its {node_ip,agent_url,sessions}; fenced by
                            KORE_AGENT_TOKEN (a different trust domain from the WB token)

SECURITY: shared-token auth (2026-09-23). Every endpoint except /api/health needs
the token from $WB_TOKEN_FILE (default workbench/.token, mode 0600, auto-generated
on first start).
  * GET  accepts `Authorization: Bearer <tok>` or `?token=<tok>`.
  * POST accepts the Bearer header ONLY. A write token in a URL ends up in browser
    history, referrers and reverse-proxy logs; reads already leaked that way and
    that is bad enough without letting it start remote processes.
Every POST also has to echo `confirm: "<verb>:<node_ip>:<session>"`, so a blind or
cross-site post cannot act without naming what it is acting on.

Writes never execute inline: koreops.py returns a job id and the work runs on a
background thread. `kore_send(wait=True)` can block for minutes, and a handler that
waited would freeze the dashboard for every other viewer.

/api/kore/stream is the first handler that deliberately occupies its thread for as long
as the client stays connected, which looks like the exact thing the paragraph above
forbids. It is allowed for three reasons, and all three are load-bearing:
  * it is a READ. The rule exists because a write holds the bridge's per-session lock;
    a capture takes no lock, so a slow one blocks nobody but its own viewer.
  * the server is ThreadingMixIn with daemon_threads, so one thread per open pane is
    the cost, and it is capped (MAX_STREAMS) with a 503 before a single byte of stream
    is written — never an unbounded thread pool.
  * it has no write counterpart that could be reached this way: do_POST only ever
    takes a verb from the /api/kore/ prefix and demands `verb in koreops.WRITE_VERBS`, and
    neither "stream" nor "streams" is in that set, so POSTing either is a 404. The SSE
    code path calls koreops.read_verb() and nothing else.
"""

from __future__ import annotations

import fcntl
import gzip
import hashlib
import hmac
import http.server
import importlib.util
import json
import os
import queue
import re
import secrets
import select
import socket
import socketserver
import subprocess
import sys
import threading
import time
import traceback
from urllib.parse import parse_qs, urlsplit

HOST = os.environ.get("WB_HOST", "127.0.0.1")
PORT = int(os.environ.get("WB_PORT", "8198"))
# 2026-10-12: 一个进程，两个门牌号。原来是两个 server.py 各占一个口（8197 给人看，8198 给
# 自检脚本），而「两个进程」意味着可以是两份代码 —— 真出过一次：8197 跑着几小时前的旧进
# 程、页面却是从磁盘读的新代码，于是 /api/kore/bytes 全 404，每个 pane 都静默降级回 1 秒一拍
# 的抓屏流，没人立刻发现。一个进程就不可能再分叉。
# 8198 不能直接丢：m45/m46 的收尾是 check("live board on 8198 still healthy")，m46 是别人
# 的文件不许改；ref/ 下还有二十来个自检脚本把 8198 写死了，它们得能原样复算。
# 同一个 Handler 多开一个监听口：同一份代码、同一份 state、同一批常驻 agent、同一个
# /api/kore/streams 槽位池。鉴权没有任何松动 —— 从哪个口进来都走 _validate。
ALSO = [int(p) for p in (os.environ.get("WB_PORT_ALSO") or "").replace(",", " ").split()]
HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.environ.get("WB_TOKEN_FILE", os.path.join(HERE, ".token"))
KORE_OPS_PATH = os.environ.get("KORE_OPS_PATH", os.path.join(os.path.dirname(HERE), "koreops.py"))
MAX_BODY = 128 * 1024

# Installed version, surfaced to the dashboard via /api/state so the titlebar can show it.
try:
    from kore import __version__ as KORE_VERSION
except Exception:        # running from an odd layout; a missing version is non-critical
    KORE_VERSION = "?"

# The client-agent registry, and the token that fences the register-push door. This is a
# SEPARATE trust domain from the WB token above: KORE_AGENT_TOKEN is the server<->client
# agent secret, carried by client agents, never by browsers. Every client reaches the
# roster through this ONE door: its agent POSTs {node_ip,agent_url,sessions} here each
# heartbeat and the server writes it into KORE_AGENTS_FILE. The server's own node needs no
# agent and no registry entry — the engine routes it locally. See kore-agent.py /
# kore-bridge.py for the readers.
KORE_AGENT_TOKEN = os.environ.get("KORE_AGENT_TOKEN", "")
KORE_AGENTS_FILE = os.path.expanduser(
    os.environ.get("KORE_AGENTS_FILE", "~/.kore/agents.json"))
_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def _agents_register(node_ip: str, agent_url: str, sessions: list) -> dict:
    """Merge ONE client's record into KORE_AGENTS_FILE under flock + atomic replace.

    The exclusive lock serializes concurrent registers from different clients, and we
    touch only this node's key, so
    atomic-replace cannot drop another agent's entry. `last_seen` is stamped with the
    BRIDGE clock — on the register path the node clock is untrusted, and TTL pruning
    (done by the readers against their own `now`) only works if the stamp shares that
    clock. Stale entries are never deleted here; readers prune by TTL, which is flap-safe.
    """
    os.makedirs(os.path.dirname(KORE_AGENTS_FILE) or ".", exist_ok=True)
    rec = {"agent_url": agent_url, "last_seen": time.time(),
           "sessions": [s for s in sessions if isinstance(s, str)]}
    with open(KORE_AGENTS_FILE + ".lock", "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            data: dict = {}
            try:
                with open(KORE_AGENTS_FILE, encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    data = {}
            except (OSError, ValueError):
                data = {}
            old = data.get(node_ip)
            if isinstance(old, dict) and old.get("started_at") is not None:
                rec["started_at"] = old["started_at"]  # preserve the agent's own uptime
            data[node_ip] = rec
            tmp = f"{KORE_AGENTS_FILE}.tmp.{os.getpid()}"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, KORE_AGENTS_FILE)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    return rec

# ROUND7-FIX-3 / C: SSE pane feeds. One open pane = one connection = one handler
# thread that polls on its own; there is no shared fan-out registry, so there is also
# nothing that can outlive a connection and leak. The cap is the whole admission
# control, and it is checked before any stream header goes out so an over-limit client
# gets an ordinary JSON 503 instead of half a stream.
MAX_STREAMS = int(os.environ.get("WB_MAX_STREAMS", "8"))
STREAM_TICK_S = 1.0          # target cadence of one capture
# ROUND9 方案 C②：有人正在往这个 pane 里打字的时候，把这条流的节奏临时提到 ~0.13s。
# 为什么要：1.0s 是「对面自己冒出来的输出」看得见的上界 —— 敲完回车、命令 300ms 后才打印
# 的那几行，要等下一拍才上屏。键本身不靠它（input 的 200 就带着打完之后的那一屏回来），
# 但本地回显猜错/对面自己动起来的那部分要靠它。
# 为什么敢：这条流推的是**行 diff**（ROUND8 阶段1 择的那个口径），一拍没变化就是 0 字节，
# 所以提频的代价是 tmux capture 的次数，不是带宽。停手 3s 之后自己落回 1.0s。
# 怎么知道「正在打字」：复用 _baselines —— 那张表是 input 的回执挂上去的，写路径一个字
# 没动，这里只读。
STREAM_TICK_FAST_S = float(os.environ.get("WB_STREAM_TICK_FAST", "0.13"))
STREAM_FAST_WINDOW_S = float(os.environ.get("WB_STREAM_FAST_WINDOW", "3.0"))
STREAM_PING_S = 15.0         # comment frame so dead connections surface
# A send deadline on the pane-feed socket. Without it, a reader whose receive
# window is full (slow/dead client that never sent FIN/RST) parks wfile.write in
# the kernel forever — _sse_peer_gone can't see it, so the handler thread, its
# queue, and the tap child all hang. Must sit above STREAM_PING_S so a healthy
# slow link is never cut; a tripped write raises socket.timeout (an OSError), which
# the stream loop already catches and turns into normal teardown.
STREAM_WRITE_TIMEOUT_S = float(os.environ.get("WB_STREAM_WRITE_TIMEOUT", "30.0"))
_stream_mu = threading.Lock()
_streams_open = 0

# ROUND8: the vendored xterm.js, served from an EXACT-FILENAME map.
#
# Nothing here is a path the caller composes: the request's last segment is looked up as
# a dict key, and the file is opened from `HERE/vendor/xterm/<that key>`. So `..`,
# absolute paths, symlink games and URL-encoded separators all land on the same answer as
# any other unknown name — 404 — without a single normalization rule to get right.
#
# These files are NOT exempt from the token the way /api/health is. A `<script src>` tag
# cannot send an Authorization header, which is the usual reason static assets end up
# open; the page gets around that by injecting the tag with `?token=` at pane-open time
# (see index.html's shell zone), so the board keeps one rule — every GET except liveness
# needs the token — instead of growing an exception.
VENDOR_DIR = os.path.join(HERE, "vendor", "xterm")
VENDOR_FILES = {
    "xterm.js": "text/javascript; charset=utf-8",
    "xterm.css": "text/css; charset=utf-8",
    "addon-fit.js": "text/javascript; charset=utf-8",
    "addon-webgl.js": "text/javascript; charset=utf-8",
    "VENDOR.md": "text/markdown; charset=utf-8",
    "LICENSE-xterm.txt": "text/plain; charset=utf-8",
    "LICENSE-addon-fit.txt": "text/plain; charset=utf-8",
    "LICENSE-addon-webgl.txt": "text/plain; charset=utf-8",
}

# 2026-10-12: 静态文件的进程内缓存 + gzip。之前每个 GET / 都现 open+read 一次 index.html
# （166KB），每个 vendor GET 现读一次 xterm.js（289KB），而且全都带 Cache-Control: no-store
# —— 侧边栏每刷一次就是 456KB 不压缩的明文 + 289KB 的 JS 重新解析，一个字节都不许缓存。
# 缓存按 (mtime, size) 失效，所以「index.html 是每次请求从磁盘读的」这条性质没被改掉：改完
# 文件下一个请求就是新的，不用重启板子（改页面一直靠这条）。
_STATIC_LOCK = threading.Lock()
_STATIC: dict = {}


def _static(path: str):
    """返回 (body, gzip 过的或 b"", etag)。按 mtime+size 失效，整个进程共用一份。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime, st.st_size)
    with _STATIC_LOCK:
        hit = _STATIC.get(path)
        if hit and hit[0] == key:
            return hit[1], hit[2], hit[3]
    with open(path, "rb") as f:
        body = f.read()
    # level 6：166KB 的页面压到 ~35KB，花 2-3ms，而且每个文件版本只花这一次。
    gz = gzip.compress(body, 6) if len(body) >= 1400 else b""
    if gz and len(gz) >= len(body):
        gz = b""
    etag = '"%s"' % hashlib.sha256(body).hexdigest()[:32]
    with _STATIC_LOCK:
        _STATIC[path] = (key, body, gz, etag)
    return body, gz, etag


def load_token() -> str:
    """Read the shared token, creating it on first start (0600, owner only)."""
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            tok = f.read().strip()
        if tok:
            return tok
    except FileNotFoundError:
        pass
    tok = secrets.token_urlsafe(32)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(tok + "\n")
    return tok


TOKEN = load_token()


def _ct_eq(a: str, b: str) -> bool:
    """Constant-time compare that tolerates non-ASCII input instead of raising.

    hmac.compare_digest raises TypeError when either str has non-ASCII chars
    (e.g. a mangled ?token= value). Encode to utf-8 bytes first so a bad token
    is simply 'not equal' rather than a 500."""
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except Exception:
        return False


def _load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_TOKEN_IN_URL = re.compile(r"([?&]token=)[^&\s]+")


def _redact(s: str) -> str:
    """把访问日志里的 `?token=…` 脱敏。

    只读 GET/SSE 合法地把口令放在查询串里（EventSource 设不了请求头，vendor 资源也是
    `<script src>`），于是**每次页面加载、每次 xterm 资源抓取**都会让 BaseHTTPRequestHandler
    把完整口令原样写进日志。日志按 umask 落盘（实测 644）、又被 .gitignore 挡在
    secret-scan.py 的视野外（那个扫描器只看 tracked 文件），所以这份副本既是全世界可读的、
    又是没人在盯的。板子绑 0.0.0.0，这个口令是网络到 POST /api/kore/stop 之间唯一一道门。
    （2026-10-12 review 的 #5。脱敏只管住往后写的那些；已经落盘的那两份日志要靠轮换口令，
    那是 owner 的决定，不在这里做。）"""
    return _TOKEN_IN_URL.sub(r"\1<redacted>", s)


def _qint(raw, default: int, lo: int, hi: int) -> int:
    """查询参数要整数：取不到/不是数字就用默认值，取到了就夹进 [lo, hi]。

    裸 `int(one("lines","120"))` 对 `lines=abc` 抛 ValueError，被 do_GET 的兜底接住之后
    返回的是一个 500 + traceback —— 一个 trivially 可达的 500（watchdog 会看到）外加一份
    带源码路径的内部结构。夹上下界这件事本来也该做：`lines=99999999` 会让远端 tmux
    capture-pane 去拉一份谁也不看的巨型回看。（2026-10-12 review 的 #7）"""
    try:
        v = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


state_mod = _load("wb_state", os.path.join(HERE, "state.py"))
koreops = _load("wb_koreops", KORE_OPS_PATH)
# One bridge instance for the whole process: its per-session locks live in module
# globals, and two copies would let two concurrent sends interleave keystrokes.
koreops.use_bridge(state_mod.bridge())

_state_lock = threading.Lock()


def _common_prefix(a: list[str], b: list[str]) -> int:
    """How many leading lines the two captures agree on, byte for byte.

    This single number is the whole diff protocol. A pane running Claude Code is not
    an append-only log: `capture-pane -p -S -400` returns 400 lines of scrollback plus
    a current screen that is redrawn in place, so "what changed" is almost always a
    suffix — new history appended (prefix = all of the old lines), or the bottom screen
    repainted (prefix = everything above it). Sending `from` = this number plus the
    lines after it covers append, repaint and full resend with one frame shape, which
    leaves the client with exactly one splice to get right instead of three.
    """
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def _screen_scroll(prev: list[str], cur: list[str]) -> int:
    """对面这一屏相对上一屏向上滚了几行（算不出来就是 0）。

    ROUND8 阶段3 的「滚动回看」卡在一件事上：`rows` 帧只在**绝对行号**上重画当屏，它永远
    不 APPEND，所以 xterm 自己的 scrollback 从开 pane 那一帧之后就不再生长 —— 对面滚掉的
    行谁都看不见了，往上滚只看到开 pane 那一刻的历史，和当屏之间断一截。xterm 的
    scrollback 只能从底部长（一行被顶出屏幕才进历史），所以客户端必须真的滚 k 行，而 k
    只有服务端拿两屏一比才知道。

    判法：上一屏去掉头 k 行，和这一屏的头 rows-k 行比，**几乎**逐行相同（连 SGR 转义码一起
    比），其中至少 2 行是非空行对上的；允许重叠区里有少数几行对不上（≤ 1/8，至少 1 行），
    因为滚动和新内容是同一拍发生的。几个 k 都站得住就取对上行数最多的那个，平手取小的。
    k 封顶在半屏：k 越大重叠区越小、证据越薄 —— 实测（ref/round8/stage3-gate.py 的 C 段，
    拿 tmux 自己的 `#{history_size}` 当独立凭据）抓到一帧判了 k=26，重叠只剩 4 行，而那一
    拍对面的 history 一行都没涨：它根本没滚，是整屏重画撞上了「屏幕末尾几行恰好对上」。
    一拍（1s）滚过半屏的 pane，那叫重画，不叫滚动；宁可漏判（回看里少几行，看的人看到
    一截断口）也不许瞎判（回看里多出几十行从没被顶出去过的内容）。
    不用 tmux 的 `#{history_size}` 差值当判据：history 撞到 history-limit 之后就不再涨，而
    屏还在滚 —— 那个差值正好在长跑的 pane 上失效（当凭据可以，当判据不行）。

    误判是安全的，这是这个启发式敢用的理由：客户端滚完 k 行之后的屏恰好是
    `prev[k:] + k 个空行`，而 dirty 是拿**同一个**位移后的基线算出来的，所以「滚 k 行 +
    补 dirty」的结果逐字节等于 cur，和 k 猜得对不对无关。猜错只是让 scrollback 多收/少收
    几行，屏上看不出来；猜对了反而连 dirty 都变小（整屏滚动时从「几乎每行都变了」缩成
    「只有新进来的那几行变了」）。
    """

    n = len(prev)
    if n < 3 or len(cur) != n or prev == cur:
        return 0
    best_k, best_m = 0, 0
    # 半屏封顶：见 docstring —— 重叠区不许薄过半屏，否则「对上了」几个字就不值钱了。
    for k in range(1, n // 2 + 1):
        tail, head = prev[k:], cur[:n - k]
        m = nb = 0
        for a, b in zip(tail, head):
            if a == b:
                m += 1
                nb += 1 if a.strip() else 0
        # 至少两行**非空**行对上：空行和空行当然对得上，半屏空白的 pane 在任何位移下都
        # 「匹配」，那种匹配什么都没说明。
        if nb < 2:
            continue
        # 允许少数几行对不上。必须允许：滚动和新内容是同一拍发生的 —— 对面把一行打进
        # 屏幕最后那个本来是空的行，再滚一行，于是「上一屏往上挪 k 行」和这一屏在重叠区
        # 的末尾差一两行。要求逐行全等的那一版在真 pane 上每一拍都返回 0（实测：一屏 30
        # 行里只差 1 行，位移 k=2 被判不成立，于是 scrollback 从开 pane 之后再没长过）。
        # 容错是安全的，理由和整个启发式的理由是同一个：dirty 是拿**位移之后**的基线算
        # 出来的，对不上的那几行一定在 dirty 里，客户端铺完还是逐字节等于 cur。
        if m < len(tail) - max(1, len(tail) // 8):
            continue
        if m > best_m:
            best_k, best_m = k, m
    return best_k



_baseline_mu = threading.Lock()
_baselines: dict[tuple[str, str], dict] = {}


def _term_baseline_put(node_ip: str, name: str, res: dict) -> None:
    """挂出「浏览器已经看到的那一屏是这个，时间戳是这个」。

    阶段2 的回显（input 的 200 带着这批键打完之后的那一屏，客户端当 rows 帧铺上去）和
    `_sse_stream` 用的是两份互不知情的基线：SSE 线拿**它自己上一拍**的屏作底，客户端屏上
    却已经是回显那一屏了。阶段2 只差在「某一行被回显改过、下一拍又恰好改回去」这种瞬态
    上，看不出来。阶段3 的 scroll 不行：位移是拿基线算的，基线错一次，屏就歪着留在那儿，
    要等下一个 full 帧才回得来。

    所以把回执屏挂出来，让那条 SSE 线下一拍把它当基线（新旧由 `_term_baseline_get` 按
    时间戳判，和客户端 `paneSeenAt` 那套仲裁同一个钟、同一个进程）。这是个**纯提示**：
    丢了、过期了、没人来取，都只退化成阶段2 的行为，不会让任何一帧变得不合法。
    """
    at, rows_n = res.get("fetched_at"), int(res.get("rows") or 0)
    if not res.get("ok") or not at or rows_n < 1:
        return
    srows = (str(res.get("output") or "").split("\n") + [""] * rows_n)[:rows_n]
    rec = {"at": float(at), "rows": srows, "geom": (res.get("cols"), rows_n),
           # put_at 是**本机**墙钟（at 是对面 reader 进程盖的章）。_stream_tick 判「刚才
           # 有没有人打字」只能用本机钟：跨节点的 at 带着时钟偏差，拿它减 time.time() 会
           # 把提频窗口算成永远开着或者永远关着。
           "put_at": time.time(),
           "stamp": (res.get("cursor_x"), res.get("cursor_y"),
                     res.get("cursor_vis"), res.get("state"))}
    now = time.time()
    with _baseline_mu:
        _baselines[(node_ip, koreops.full_name(name))] = rec
        for key in [k for k, v in _baselines.items() if now - v["at"] > 120]:
            _baselines.pop(key, None)


def _term_baseline_get(node_ip: str, name: str, after: float) -> dict | None:
    """那一屏比这条流自己发出去的最后一帧更新吗？是就拿走当基线，不是就 None。"""
    with _baseline_mu:
        rec = _baselines.get((node_ip, koreops.full_name(name)))
    return rec if rec and rec["at"] > after else None


def _stream_tick(node_ip: str, name: str) -> float:
    """这条流下一拍该隔多久：有人刚往这个 pane 里打过字就提频，停手就落回去。

    判据是 `_baselines` 里那条记录的 `put_at` —— 它只在同步写（input / ROUND9 的 resize）
    的回执落地时才被写一次，所以「最近 STREAM_FAST_WINDOW_S 秒内有过一次成功的 input 或
    resize」就是「有人正在动这个 pane」。两者都该提频：一个是打字，一个是刚把对面调成新
    的几何、整屏正在重画。
    只读这张表：写路径（`do_POST` / `_bearer_ok` / `koreops.input_keys`）一个字节没动，
    而且取不到记录、取到的是旧的、表被清过，都只退化成原来的 1.0s。
    """
    with _baseline_mu:
        rec = _baselines.get((node_ip, koreops.full_name(name)))
    put_at = float((rec or {}).get("put_at") or 0)
    if put_at and time.time() - put_at < STREAM_FAST_WINDOW_S:
        return STREAM_TICK_FAST_S
    return STREAM_TICK_S


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("[workbench] %s\n" % _redact(fmt % args))

    def _bearer_ok(self) -> bool:
        """Header-only check. This is the sole gate on every write."""
        header = self.headers.get("Authorization", "")
        return header.startswith("Bearer ") and _ct_eq(header[7:].strip(), TOKEN)

    def _authorized(self, query: str) -> bool:
        """Reads: Bearer header, else ?token=. Constant-time either way."""
        if self._bearer_ok():
            return True
        return any(_ct_eq(s, TOKEN) for s in parse_qs(query).get("token", []))

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store",
              etag: str = "", gz: bytes = b"") -> None:
        # 2026-10-12: 加了 gzip 协商。页面 166KB、xterm.js 289KB，原来全是不压缩明文。
        # gz 参数给静态文件走预压好的那份（每个文件版本只压一次）；动态 JSON 现压，
        # level 5 是 CPU 和体积的折中。
        # SSE 不走这条路（它用 _sse_open），所以不存在「压了的流推不出去」那种事。
        if not gz and len(body) >= 1400 and self._accepts_gzip() and (
                ctype.startswith(("text/", "application/json", "image/svg"))
                or "javascript" in ctype):
            cand = gzip.compress(body, 5)
            if len(cand) < len(body):
                gz = cand
        use_gz = bool(gz) and self._accepts_gzip()
        out = gz if use_gz else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        # 2026-10-12: when we've decided to drop the socket (e.g. an over-cap
        # body left unread bytes behind), say so. Without this a keep-alive
        # client assumes reuse and desyncs on its next request against a socket
        # we've already closed. http.server does not emit this on its own.
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(out)

    def _send_static(self, path: str, ctype: str, cache: str) -> None:
        """静态文件：进程内缓存 + 预压好的 gzip + ETag/If-None-Match 的 304。"""
        got = _static(path)
        if got is None:
            self._send(404, b'{"error":"not found"}', "application/json")
            return
        body, gz, etag = got
        if etag and etag in (self.headers.get("If-None-Match") or ""):
            # 304 不带 body，也就不需要 Content-Length/Content-Encoding。
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return
        self._send(200, body, ctype, cache=cache, etag=etag, gz=gz)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8")

    def _read_body(self) -> bytes:
        """Read the body, capped at MAX_BODY+1 so do_POST can detect overflow.

        An over-cap body cannot be fully read without either draining
        attacker-controlled volume (a DoS surface) or leaving leftover bytes in
        the socket, which would desync the next request on a keep-alive
        connection. So when Content-Length declares an over-cap body, mark the
        connection to close: the leftover bytes die with the connection instead
        of being parsed as the next request."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        if n > MAX_BODY:
            self.close_connection = True
        return self.rfile.read(min(n, MAX_BODY + 1))

    # ------------------------------------------------------------------ GET

    def _get_api(self, path: str, q: dict[str, list[str]]) -> bool:
        one = lambda k, d="": (q.get(k) or [d])[0]  # noqa: E731
        if path == "/api/state":
            # Lean kore-only snapshot: the effective write policy + the live kore roster +
            # how many pane feeds are open. Serialized so concurrent browser polls collapse
            # into one roster refresh instead of each paying its own node round trips.
            with _state_lock:
                roster = koreops.roster(one("scan", "registry"), force=one("force") == "1")
            with _stream_mu:
                streams = {"open": _streams_open, "max": MAX_STREAMS}
            prefix = getattr(state_mod.bridge(), "TMUX_PREFIX", "kore-")
            self._json(200, {"ok": True, "policy": koreops.policy(),
                             "roster": roster, "streams": streams, "prefix": prefix,
                             "version": KORE_VERSION})
        elif path == "/api/kore/policy":
            self._json(200, {"ok": True, "policy": koreops.policy()})
        elif path == "/api/kore/roster":
            r = koreops.roster(one("scan", "registry"), force=one("force") == "1")
            if isinstance(r, dict):   # tell the UI the live prefix so it never hardcodes it
                r.setdefault("prefix", getattr(state_mod.bridge(), "TMUX_PREFIX", "kore-"))
                r.setdefault("version", KORE_VERSION)   # so the titlebar can show the build
            self._json(200, r)
        elif path in ("/api/kore/read", "/api/kore/status"):
            verb = path.rsplit("/", 1)[1]
            kw = {"lines": _qint(one("lines"), 120, 1, 5000),
                  # ROUND8: same read verb, ANSI left in (capture-pane -e) plus the
                  # geometry and cursor the emulator needs. Here so the exact payload the
                  # stream pushes can be fetched once, by hand, with curl — a frame shape
                  # you can only see by holding an SSE connection open is a frame shape
                  # nobody checks.
                  "ansi": one("ansi", "") in ("1", "true", "yes"),
                  "screen": one("screen", "") in ("1", "true", "yes")} \
                if verb == "read" else {}
            self._json(200, koreops.read_verb(verb, one("node_ip"), one("name"),
                                            who=self._who(), **kw))
        elif path == "/api/kore/streams":
            # Observability for the cap, and the only way a test can prove a feed was
            # released rather than merely stopped being watched: open a pane -> 1,
            # close it -> 0. Read-only, and `POST /api/kore/streams` is a 404 because
            # "streams" is not in koreops.WRITE_VERBS.
            with _stream_mu:
                self._json(200, {"ok": True, "open": _streams_open, "max": MAX_STREAMS})
        elif path == "/api/kore/stream":
            # Deliberately node_ip + name, NOT ?session=. The pane this streams is
            # addressed exactly the way /api/kore/read addresses it — same two
            # parameters, same koreops.read_verb() call — so the three structural
            # assertions that say the control half's /api/kore/ URLs never carry a
            # `session` parameter (that is the observe half's vocabulary) keep holding
            # without a word of rewording.
            self._sse_stream(one("node_ip"), one("name"),
                             _qint(one("lines"), 400, 1, 5000), one("mode", "lines"))
        elif path == "/api/kore/bytes":
            # ROUND10: the same pane, addressed the same two ways (node_ip + name, never
            # ?session=), streamed as bytes instead of as screens. A separate path rather
            # than a third `mode=` on /api/kore/stream because nothing is shared: no capture,
            # no diff, no tick, no baseline table — one `koreops.py tap` child and a relay.
            self._sse_bytes(one("node_ip"), one("name"))
        elif path == "/api/agents":
            # Read-only observability for the client-agent registry: which clients the
            # engine currently believes are reachable, pruned by TTL so the dashboard sees
            # the same live set the engine routes to. Guarded by the WB token (it is a read
            # of bridge state), NOT the agent token.
            eng = state_mod.bridge()
            prune = getattr(eng, "agents_prune", None)
            self._json(200, {"ok": True, "agents": prune() if prune else {}})
        elif path == "/api/kore/jobs":
            self._json(200, {"ok": True, "jobs": koreops.jobs(_qint(one("limit"), 30, 1, 500))})
        elif path == "/api/kore/job":
            j = koreops.job(one("id"))
            self._json(200 if j else 404, j or {"ok": False, "error": "no such job"})
        else:
            return False
        return True

    def _sse_open(self) -> None:
        """Headers for a stream, which is why this cannot go through _send().

        _send() always writes a Content-Length, and a stream has no length yet. Under
        HTTP/1.1 the alternatives are chunked framing or close-delimited framing;
        close-delimited is chosen because `Connection: close` + close_connection=True
        is two lines of truth, while hand-rolled chunk headers are a second framing
        implementation to keep correct for no gain on a localhost board.
        """
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")   # no proxy may buffer a live feed
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.flush()

    def _sse_frame(self, event: str, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False)
        self.wfile.write(f"event: {event}\ndata: {body}\n\n".encode())
        self.wfile.flush()

    def _sse_peer_gone(self) -> bool:
        """Has the viewer closed the pane?

        Without this the answer only arrives the next time we try to WRITE, and a quiet
        pane writes nothing between 15s heartbeats — so `/api/kore/streams` would still
        report the feed open long after the browser let go, and "closing the pane
        releases the feed" would be true but unobservable. An SSE client never sends a
        second byte, so a socket that has become readable can only be EOF; MSG_PEEK
        asks without consuming anything.
        """
        try:
            if not select.select([self.connection], [], [], 0)[0]:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _sse_stream(self, node_ip: str, name: str, lines: int, mode: str = "lines") -> None:
        """One open pane: capture, diff against what this client has already been sent,
        push only the difference, repeat ~1s.

        Two frame shapes, chosen by `mode`, because there are two clients:

          * `lines` (default) — the ROUND7 protocol: `{from, lines, total, state}` over
            ANSI-STRIPPED text, spliced into a `<pre>`. Still the fallback path, and still
            what a browser without xterm.js gets.
          * `term` — ROUND8: text with the escape codes LEFT IN, for `term.write()`.
            `kind: "full"` once (scrollback + screen, so xterm's own scrollback holds
            real history), then `kind: "rows"` per tick — only the SCREEN ROWS that
            changed, as `dirty: [[row_index, ansi_text], …]`, which the client repaints at
            absolute row addresses. Every frame also carries the geometry and the cursor,
            and every `rows` frame carries `scroll`: how many lines the far side's screen
            scrolled up this tick (ROUND8 阶段3, `_screen_scroll` —— 客户端照着真滚那么多
            行，被顶出屏幕的行才会进 xterm 自己的 scrollback，回看才有东西可看). `dirty`
            是拿**滚完之后**的基线算的，两件事必须一起用。

        Why rows and not a byte-level diff of the scrollback window, with the measured
        numbers (ref/round8/stage1-frame-bytes*.txt, three real panes × 15-20 拍 × 1s):

          pane                         A: 窗口字节 diff   B: 整屏   C: 只推变了的行
          claude-code（真 TUI）              77,159B    46,033B    7,586B  ← 10.2× / 6.1×
          r8scroll，窗口还没填满             10,576B    26,680B   30,423B
          r8scroll，窗口填满后(history 1211) 368,025B    20,010B   22,768B

        A looks fine in the middle row only because that window had not yet filled: while
        history < 400 lines nothing is evicted from the front, so the common prefix holds.
        Once it fills, every tick evicts lines off the front, the prefix collapses to zero
        and A resends the whole window — 24,535B per tick, 16× C, and unbounded in the
        window size. A is also not a legal incremental terminal stream: the cut can land
        inside an escape sequence, and the suffix would be written wherever the cursor
        happens to be rather than where it belongs.

        C's own worst case is the bottom row — when the pane scrolls, every row changes
        and C degenerates to B plus the JSON row numbers (+14%). That is the whole downside
        and it is bounded by one screen. On the actual target (claude-code redraws in
        place, it does not scroll) C is 6-10× cheaper and costs 0 bytes when idle. Rows
        are also addressed, so they land in the right place by construction — and because
        a repaint never APPENDS a line, a reader who has scrolled up is never yanked down.
        The task doc blessed whole-screen repaint as the fallback; C is that fallback with
        the unchanged rows left out.

        The error handling here is not the usual shape on purpose. do_GET's fallback is
        `except Exception -> _fault() -> _json(500, ...)`, and a JSON 500 written after
        the first `data:` frame would inject a second status line and a Content-Length
        into the middle of the stream — the client would see garbage instead of a
        disconnect. So this method catches its own exceptions and just stops: a closed
        stream IS the error report at the transport level, and anything we can describe
        goes out as an `err` frame first.
        """
        global _streams_open
        if not node_ip or not name:
            self._json(400, {"ok": False, "error": "stream needs node_ip and name"})
            return
        lines = max(1, min(2000, lines))
        term = mode == "term"
        with _stream_mu:
            if _streams_open >= MAX_STREAMS:
                self._json(503, {"ok": False, "open": _streams_open, "max": MAX_STREAMS,
                                 "error": f"too many open pane feeds ({MAX_STREAMS})"})
                return
            _streams_open += 1
        try:
            self._sse_open()
            prev: list[str] = []
            prev_rows: list[str] = []
            prev_geom: tuple = ()
            prev_stamp: tuple = ()
            prev_at = 0.0               # 本条流最后发出去的那一帧的服务端时间戳
            first, last_state, last_ping = True, None, time.time()
            while True:
                t0 = time.time()
                if self._sse_peer_gone():
                    return
                # ONE read call site for both modes, differing only in what it asks for.
                # Not two: `read_verb` is the single koreops entry this whole code path is
                # allowed to name, and a second call site is a second place for a write
                # symbol to turn up later.
                want = {"lines": lines}
                if term:
                    want = {"lines": lines, "ansi": True, "screen": not first}
                # ROUND9 方案 C②的另一半：节奏提到 0.13s 之后，光提节奏没用 —— koreops 那边
                # 对 read 有 read_cache_s=0.5 的缓存，0.13s 一拍里有四拍会原地拿回同一张旧
                # 屏，「高频纠正」就成了高频重复。max_age 把这一拍能接受的最大年龄说出来：
                # 它只会**收紧** TTL（ttl = min(policy, max_age)），放不松，所以提不了别人
                # 的权限，也动不了策略文件里那个数。
                #
                # 为什么是 tick/2 而不是 tick：第一版写的 max_age=tick，实测出来这条流的帧
                # 间隔是 0.146/0.244 交替（tap 8198 量的），不是干净的 0.13 —— 允许的年龄
                # 正好等于一拍，于是每隔一拍就合法地拿回**上一拍那张一模一样的屏**，diff 空
                # 了就不发帧，有效节奏退化成 ~0.195s。砍一半之后缓存只在「同一个 pane 被多条
                # 流同时看」的时候帮忙合并，不会跨拍复用。真读一次 ~17ms（常驻 read agent，
                # 实测中位数 17.55ms），所以这里不是性能问题。停手回落到 1.0s 之后 max_age
                # 是 0.5，和策略里的 read_cache_s 同值，省流量那一头照旧。
                tick = _stream_tick(node_ip, name)
                try:
                    r = koreops.read_verb("read", node_ip, name, who=self._who(),
                                        max_age=tick / 2, **want)
                except koreops.KoreOpsError as exc:
                    self._sse_frame("err", {"error": str(exc), "refused": True})
                    return                      # a refusal will not un-refuse itself
                except Exception as exc:        # noqa: BLE001 - say why, then give up
                    sys.stderr.write("[workbench] stream error\n" + traceback.format_exc())
                    self._sse_frame("err", {"error": f"{type(exc).__name__}: {exc}"})
                    return
                if not r.get("ok"):
                    # Degraded read: keep the feed open (the agent self-heals) but never
                    # show a blank pane without a reason.
                    self._sse_frame("err", {"error": r.get("error") or "capture failed",
                                            "probe": r.get("probe") or {}})
                elif term:
                    text, state = r.get("output") or "", r.get("state")
                    rows_n = max(1, int(r.get("rows") or 24))
                    # The visible screen is always the TAIL: a `full` payload is
                    # scrollback + screen, a per-tick payload is the screen alone, and
                    # koreops pads it to exactly `rows` lines either way.
                    srows = text.split("\n")[-rows_n:]
                    geom = (r.get("cols"), rows_n)
                    # The cursor moves without a single character changing — which is most
                    # of what a prompt does — so it is part of "did anything change".
                    stamp = (r.get("cursor_x"), r.get("cursor_y"),
                             r.get("cursor_vis"), state)
                    meta = {"state": state, "cols": r.get("cols"), "rows": rows_n,
                            "cx": r.get("cursor_x"), "cy": r.get("cursor_y"),
                            "cvis": r.get("cursor_vis"), "alt": r.get("alt"),
                            "in_mode": r.get("in_mode"),
                            "history": r.get("history_size"),
                            "bytes": r.get("bytes"), "clipped": r.get("clipped_bytes"),
                            "at": r.get("fetched_at")}
                    if not first and geom != prev_geom:
                        # The far side was resized. Nothing is sent this tick: a
                        # row-addressed patch against the old geometry would land in the
                        # wrong places. Asking again with history costs one tick and
                        # produces a frame that is right instead of nearly right.
                        first = True
                    elif first:
                        self._sse_frame("term", {"kind": "full", "text": text, **meta})
                        prev_rows, prev_geom, prev_stamp = srows, geom, stamp
                        prev_at = float(r.get("fetched_at") or 0)
                        first, last_ping = False, time.time()
                    else:
                        # 基线交接：浏览器可能已经从 input 的 200 里看到过比我上一拍更新的
                        # 一屏（阶段2 的回显）。那它的屏就是那一屏，位移和 dirty 都得拿它
                        # 当底，不然滚的行数会算错。详见 _term_baseline_put。
                        echo = _term_baseline_get(node_ip, name, prev_at)
                        if echo and echo["geom"] == prev_geom:
                            prev_rows, prev_stamp, prev_at = (echo["rows"], echo["stamp"],
                                                              echo["at"])
                        # The whole term diff: which SCREEN ROWS changed. Measured on real
                        # panes against the two alternatives (see the docstring and
                        # ref/round8/stage1-frame-choice.md): 7,586B over 20 ticks of a real
                        # claude-code pane, against 46,033B for a full repaint and 77,159B
                        # for a byte-prefix diff of the sliding scrollback window. An idle
                        # tick costs 0. The field is `dirty`, not `rows`: `rows` is already
                        # the row COUNT in meta, and one name for two things would have the
                        # dict literal silently drop the payload.
                        # 滚动过的那几行不算「变了」：基线先按位移对齐，dirty 就只剩真的
                        # 新内容 —— 这既是回看能长出来的前提，也顺手把整屏滚动那个最坏
                        # 情形从「每行都重发」压回「只发新进来的几行」。
                        scrolled = _screen_scroll(prev_rows, srows)
                        base = (prev_rows[scrolled:] + [""] * scrolled) if scrolled \
                            else prev_rows
                        dirty = [[i, ln] for i, (ln, p)
                                 in enumerate(zip(srows, base)) if ln != p]
                        if dirty or scrolled or stamp != prev_stamp:
                            self._sse_frame("term", {"kind": "rows", "dirty": dirty,
                                                     "scroll": scrolled, **meta})
                            prev_rows, prev_stamp = srows, stamp
                            prev_at = float(r.get("fetched_at") or 0)
                            last_ping = time.time()
                else:
                    cur = (r.get("output") or "").split("\n")
                    state = r.get("state")
                    if first or cur != prev or state != last_state:
                        p = _common_prefix(prev, cur)
                        self._sse_frame("patch", {"from": p, "lines": cur[p:],
                                                  "total": len(cur), "state": state})
                        prev, last_state, first = cur, state, False
                        last_ping = time.time()
                if time.time() - last_ping >= STREAM_PING_S:
                    self.wfile.write(b": ping\n\n")   # comment frame: no event, no data
                    self.wfile.flush()
                    last_ping = time.time()
                # 这一觉也得听提频。原来这里是一句 time.sleep(tick - 已用)，一次睡满：
                # tick 是在**这一拍开头**算的，而键盘是在这一觉中间落下来的 —— 于是人按下
                # 第一个键之后，对面的第一次回声还是要等满剩下的那一秒，提频只对第二帧之后
                # 生效。真量到过：浏览器里一键之后的第一发注入 468/340/492ms，而窗口早就开着
                # 的那条流是 24–124ms（ref/round9/r9-far-sse.py）。所以切成 50ms 一段，每段
                # 重新问一次该睡多久：put_at 一写进来，剩下的觉立刻就不欠了，切换代价 ≤50ms。
                floor = time.time() + 0.03        # 两次抓屏之间至少隔 30ms，别打穿
                while True:
                    left = max(_stream_tick(node_ip, name) - (time.time() - t0),
                               floor - time.time())
                    if left <= 0:
                        break
                    time.sleep(min(0.05, left))
        except (BrokenPipeError, ConnectionResetError, OSError):
            return                              # the viewer closed the pane; normal
        finally:
            with _stream_mu:
                _streams_open -= 1

    def _sse_bytes(self, node_ip: str, name: str) -> None:
        """One open pane, as BYTES. The feed with no tick in it.

        `/api/kore/stream` asks the far side for a *screen* on a cadence and ships the
        difference. That is why the pane felt slow: measured on this board the capture
        itself is ~21ms and the cadence was 1000ms idle / 130ms while typing, so almost
        all of the lag was the wait, and no cadence is short enough to fix it — polling
        for keystroke echo pays a round trip per frame whether or not anything happened.

        This path keeps no cadence at all. `koreops.py tap` owns a `tmux -C attach -r`
        client on the node; its stdout carries bytes the instant the pane produces them
        (1.5-2.0ms byte→here, measured), and this method is a relay between that pipe and
        the SSE wire. It decides nothing about terminal semantics — that is the whole
        point, because every decision is one more thing that can be wrong about somebody
        else's terminal.

        It is a READ door: `?token=` is allowed here exactly as it is on
        `/api/kore/read`, and the child validates with the `read` verb. Keystrokes still go
        through `POST /api/kore/input` and geometry still goes through `POST /api/kore/resize`.
        Nothing on this path can write to the far side; `-r` is what makes that structural
        rather than a promise.

        Frames:
          prime {text, cols, rows}  the cached capture, out in ~20ms so the pane is not
                                    blank while the tap attaches (the attach + first
                                    control-mode paint takes longer than a capture)
          hello {cols, rows}        attached; the NEXT `out` is a full repaint, so the
                                    client resets its emulator before writing it and the
                                    primed screen cannot be left underneath
          out   {b64}               bytes for `term.write()`
          geom  {cols, rows}        the far window changed size (a repaint rides along)
          err   {error}             over — refused, dead session, child gone

        Same error shape and the same reason as `_sse_stream`: once a `data:` frame has
        gone out, a JSON 500 would inject a status line into the middle of the stream, so
        this method catches its own exceptions, says what it can in an `err` frame, and
        stops.
        """
        global _streams_open
        if not node_ip or not name:
            self._json(400, {"ok": False, "error": "bytes needs node_ip and name"})
            return
        # Two caps, and the smaller wins: MAX_STREAMS counts open pane feeds on this
        # board, `tap_max_streams` counts resident processes this board may hold on
        # somebody else's node. The second is the one that costs them something.
        cap = min(MAX_STREAMS, int(koreops.policy().get("tap_max_streams", 8) or 8))
        with _stream_mu:
            if _streams_open >= cap:
                self._json(503, {"ok": False, "open": _streams_open, "max": cap,
                                 "error": f"too many open pane feeds ({cap})"})
                return
            _streams_open += 1
        child = None
        try:
            # This connection is Connection: close (one pane feed), so a socket-level
            # deadline here touches nothing else. It bounds a blocked write so a wedged
            # client can't pin this thread + the tap child indefinitely.
            self.connection.settimeout(STREAM_WRITE_TIMEOUT_S)
            self._sse_open()
            self._tap_prime(node_ip, name)
            child = koreops.tap_spawn(node_ip, name, who=self._who())
            lines: queue.Queue = queue.Queue()

            def drain(fh, q: queue.Queue) -> None:
                """Unbounded on purpose: the thing that bounds memory here is the tap's
                own `tap_chunk_max_bytes` (it drops its backlog and repaints), and a
                bounded queue would instead block this thread forever on a slow viewer."""
                try:
                    for raw in fh:
                        q.put(raw)
                except (OSError, ValueError):
                    pass
                q.put(b"")                      # EOF, as a frame the loop can see

            threading.Thread(target=drain, args=(child.stdout, lines), daemon=True,
                             name="wb-tap-relay").start()
            while True:
                # 0.5s is not a cadence — nothing is fetched here. It is how often this
                # thread gets to ask whether the viewer is still there, which it cannot do
                # while blocked on a queue.
                if self._sse_peer_gone():
                    return
                try:
                    raw = lines.get(timeout=0.5)
                except queue.Empty:
                    continue
                if not raw:
                    self._sse_frame("err", {"error": "tap 子进程没了（看板子的 stderr）"})
                    return
                if not self._tap_relay(raw):
                    return
        except (BrokenPipeError, ConnectionResetError, OSError):
            return                              # the viewer closed the pane; normal
        except Exception as exc:                # noqa: BLE001 - say why, then stop
            sys.stderr.write("[workbench] bytes stream error\n" + traceback.format_exc())
            try:
                self._sse_frame("err", {"error": f"{type(exc).__name__}: {exc}"})
            except OSError:
                pass
        finally:
            # SIGTERM, then SIGKILL. koreops' tap child turns SIGTERM into a clean shutdown
            # that closes the remote control-mode process before exiting, so the thing
            # this board borrowed on another node is gone by the time the pane animation
            # finishes, not whenever the far side happens to notice.
            if child is not None:
                try:
                    child.terminate()
                    # Grace must exceed the child's own cleanup budget, or we SIGKILL it
                    # mid-shutdown and leave the remote `tmux -C` attach dangling. The tap
                    # child closes its pane on SIGTERM — give it more than that budget
                    # before the kill.
                    child.wait(timeout=12)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        child.kill()
                    except OSError:
                        pass
            with _stream_mu:
                _streams_open -= 1

    def _tap_prime(self, node_ip: str, name: str) -> None:
        """The blank-pane patch: one cached capture, so something is on screen in ~20ms.

        Screen only, no scrollback (`screen: True`): the tap's own first paint carries the
        history, and the client resets before writing it, so this frame is allowed to be
        the wrong *age* but never the wrong *shape*. A failure here is not an error — it
        just means the pane stays blank for the second it takes the tap to attach — so it
        is swallowed, which is also why it is not inside the relay loop.
        """
        try:
            r = koreops.read_verb("read", node_ip, name, who=self._who(),
                                lines=400, ansi=True, screen=True)
        except Exception:                        # noqa: BLE001 - best effort, by design
            return
        if r.get("ok"):
            self._sse_frame("prime", {"text": r.get("output") or "", "cols": r.get("cols"),
                                      "rows": r.get("rows"), "state": r.get("state"),
                                      "cx": r.get("cursor_x"), "cy": r.get("cursor_y")})

    def _tap_relay(self, raw: bytes) -> bool:
        """One line of the child's protocol → one SSE frame. False means stop.

        The vocabulary is koreops' (`r`/`o`/`g`/`h`/`e`, see `_tap_say`). An unknown kind is
        ignored rather than fatal: a tap from a newer koreops must not be able to kill a
        running stream with a line this board has not learned yet.
        """
        kind, _, rest = raw.rstrip(b"\r\n").partition(b" ")
        if kind == b"o":
            self._sse_frame("out", {"b64": rest.decode("ascii", "replace")})
        elif kind in (b"r", b"g"):
            cols, _, rows = rest.partition(b"x")
            try:
                geom = {"cols": int(cols), "rows": int(rows)}
            except ValueError:
                return True
            self._sse_frame("hello" if kind == b"r" else "geom", geom)
        elif kind == b"h":
            # The tap's heartbeat becomes the stream's heartbeat: a comment frame, so a
            # dead connection surfaces here instead of staying open on a quiet pane.
            self.wfile.write(b": ping\n\n")
            self.wfile.flush()
        elif kind == b"e":
            self._sse_frame("err", {"error": rest.decode("utf8", "replace")})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        path = parts.path
        try:
            # Liveness stays open so `service.sh status` needs no secret.
            if path == "/api/health":
                self._send(200, b'{"ok":true}', "application/json")
                return
            if not self._authorized(parts.query):
                self._send(401, b'{"error":"unauthorized"}', "application/json")
                return
            if path in ("/", "/index.html"):
                # 页面本身不许被缓存住（改页面是常事，而且不能让人看到旧的那一份），但
                # 带 ETag：内容没变时浏览器拿 304，省掉 166KB 的重传。
                self._send_static(os.path.join(HERE, "index.html"),
                                  "text/html; charset=utf-8", "no-cache")
                return
            if path.startswith("/vendor/xterm/"):
                # Exact-filename map, read-only, token already checked above.
                name = path[len("/vendor/xterm/"):]
                ctype = VENDOR_FILES.get(name)
                if not ctype:
                    self._send(404, b'{"error":"not found"}', "application/json")
                    return
                # vendor 下那几个文件是 sha256 钉死的版本（见 VENDOR.md），内容永远不会在
                # 同一个文件名下变 —— immutable 就是给这种文件用的。xterm.js 289KB 一年只
                # 下一次，而且 gzip 之后 ~70KB。
                self._send_static(os.path.join(VENDOR_DIR, name), ctype,
                                  "public, max-age=31536000, immutable")
                return
            if not self._get_api(path, parse_qs(parts.query)):
                self._send(404, b'{"error":"not found"}', "application/json")
        except koreops.KoreOpsError as exc:
            self._json(403, {"ok": False, "refused": str(exc)})
        except Exception:  # noqa: BLE001 - report the fault instead of dropping the connection
            self._fault()

    # ----------------------------------------------------------------- POST

    def _who(self) -> str:
        return f"wb:{self.client_address[0]}"

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        raw = self._read_body()
        try:
            if len(raw) > MAX_BODY:
                self._json(413, {"ok": False, "error": f"body over {MAX_BODY}B"})
                return
            # Agent registration is a DIFFERENT trust domain: it authenticates with the
            # agent token, carries no `confirm`, and is not a WRITE_VERBS member — so it
            # must be dispatched BEFORE the WB-token write gate below, not routed through
            # it. Everything past this point is the browser write door.
            if path == "/api/agents/register":
                self._agents_register_endpoint(raw)
                return
            # Deliberately NOT self._authorized(): a write token must never be
            # accepted from the query string. See the module docstring.
            if not self._bearer_ok():
                self._json(401, {"ok": False,
                                 "error": "unauthorized: writes require an "
                                          "Authorization: Bearer header, not ?token="})
                return
            verb = path.rsplit("/", 1)[1] if path.startswith("/api/kore/") else ""
            if verb not in koreops.WRITE_VERBS:
                self._json(404, {"ok": False, "error": f"no write endpoint {path!r}"})
                return
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                self._json(400, {"ok": False, "error": f"bad JSON body: {exc}"})
                return
            if not isinstance(body, dict):
                self._json(400, {"ok": False, "error": "body must be a JSON object"})
                return

            node_ip, name = str(body.get("node_ip") or ""), str(body.get("name") or "")
            want = f"{verb}:{node_ip}:{koreops.full_name(name) if name else ''}"
            if str(body.get("confirm") or "") != want:
                self._json(400, {"ok": False, "error": f"confirm must equal {want!r}",
                                 "hint": "a write has to name its own target"})
                return
            params = {k: v for k, v in body.items()
                      if k in ("cwd", "role", "message", "key", "wait", "timeout",
                               # ROUND8: the keystroke batch, as hex codepoints. Checked
                               # by koreops HEX_RE / max_input_codepoints, not here — this
                               # whitelist decides what MAY be named, never what is valid.
                               "hex",
                               # ROUND10: `echo: false` — 回执里不要那一屏。只给「已经
                               # 在用 /api/kore/bytes 看同一个 pane」的客户端用，它要的是
                               # 更少的东西（一条 send-keys，没有 settle、没有抓屏），
                               # 所以这个名字不可能放宽任何一道闸。koreops._validate_params
                               # 把它正规化成真 bool，不传 = True = 老行为。
                               "echo",
                               # ROUND9: the far window's new geometry (two ints) and
                               # `auto`, the flag a closing pane uses to hand the window
                               # back to its attached clients. Bounds are koreops policy
                               # (resize_min/max_cols/rows), not here — this whitelist
                               # decides what MAY be named, never what is valid.
                               "cols", "rows", "auto",
                               # R6-DASHBOARD: audit-only provenance ({run_id, round,
                               # task_id}). koreops._clean_origin() shape-checks it and can
                               # never refuse the write, so letting it through this
                               # whitelist grants no new authority — it only lets a
                               # caller say which loop round a write belongs to.
                               "origin")}
            if verb == "input":
                # Synchronous, no job row: the receipt a keystroke needs is the screen it
                # produced, and 200 with that screen is a truer answer than 202 with a job
                # id nobody will poll. Everything ABOVE this line still ran: Bearer-only,
                # the WRITE_VERBS membership check, and `confirm` naming this exact target.
                # koreops.input_keys() then runs the same _validate() as every other write.
                res = koreops.input_keys(node_ip, name, who=self._who(),
                                       hex_keys=str(params.get("hex") or ""),
                                       echo=bool(params.get("echo", True)))
                # 回执这一屏客户端会当 rows 帧铺上去，所以同一个 pane 那条 SSE 线的基线也
                # 得跟着走一步，否则阶段3 的位移是拿一张过期的屏算的。只读提示，详见
                # _term_baseline_put；放在 _json 之前是因为下一拍可能比这个响应先到客户端。
                _term_baseline_put(node_ip, name, res)
                self._json(200, res)
                return
            if verb == "resize":
                # ROUND9，同 input：同步、没有 job 行。这是「把对面那个 tmux window 调成
                # 浏览器盒子的大小」那一下 —— owner 的裁定是「固定字号 + 对面跟着窗口变」，
                # 所以字号不再跟着几何走，几何改成跟着盒子走。它是**写**（对面会重画，别的
                # attach 着的客户端也会跟着跳，而且 tmux 会把那个 window 的 window-size
                # 钉成 manual），所以这一行上面那三道 —— Bearer-only、WRITE_VERBS 成员、
                # confirm 点名这个目标 —— 一道都没少，koreops.resize_window() 里跑的还是和
                # 其他写一样的 _validate()，外加它自己那条 60/min。
                # 回执带着调完之后的那一屏，和 input 的 200 同一个形状，所以基线也要跟着走
                # 一步（否则下一拍的行 diff 是拿一张旧几何的屏算的）。
                res = koreops.resize_window(
                    node_ip, name, cols=params.get("cols"), rows=params.get("rows"),
                    auto=bool(params.get("auto")), who=self._who())
                _term_baseline_put(node_ip, name, res)
                self._json(200, res)
                return
            self._json(202, koreops.submit(verb, node_ip, name, who=self._who(), **params))
        except koreops.KoreOpsError as exc:
            # A refusal is a result: 403 with the reason, never a blank panel.
            self._json(403, {"ok": False, "refused": str(exc)})
        except Exception:  # noqa: BLE001
            self._fault()

    def _agents_register_endpoint(self, raw: bytes) -> None:
        """Agent → bridge registry push (the FS-not-shared fallback).

        Authenticated by KORE_AGENT_TOKEN as a Bearer header — a trust domain distinct from
        the WB token, so a browser token can never register an agent and an agent token
        can never drive a pane. REFUSED outright when no agent token is configured: this
        endpoint writes an `agent_url` that later receives `/exec`, so an unauthenticated
        door here is remote code execution on whatever that URL points at. The bridge
        stamps its own clock (see `_agents_register`), so a skewed node cannot pin a stale
        record.
        """
        if not KORE_AGENT_TOKEN:
            self._json(503, {"ok": False,
                             "error": "agent registration disabled: set KORE_AGENT_TOKEN "
                                      "on the bridge to enable the register-push door"})
            return
        hdr = self.headers.get("Authorization", "")
        if not (hdr.startswith("Bearer ") and _ct_eq(hdr[7:].strip(), KORE_AGENT_TOKEN)):
            self._json(401, {"ok": False, "error": "unauthorized: agent token required"})
            return
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._json(400, {"ok": False, "error": f"bad JSON body: {exc}"})
            return
        if not isinstance(body, dict):
            self._json(400, {"ok": False, "error": "body must be a JSON object"})
            return
        node_ip = str(body.get("node_ip") or "")
        agent_url = str(body.get("agent_url") or "")
        sessions = body.get("sessions")
        if not _IP_RE.match(node_ip) or not agent_url.startswith(("http://", "https://")):
            self._json(400, {"ok": False,
                             "error": "need node_ip (dotted quad) + http(s) agent_url"})
            return
        rec = _agents_register(node_ip, agent_url,
                               sessions if isinstance(sessions, list) else [])
        self._json(200, {"ok": True, "node_ip": node_ip, "record": rec})

    def _fault(self) -> None:
        """500 的出口：traceback 进 stderr（日志里要看得到），回给调用方的只有一个短编号。

        原来回的是 `{"error": tb[-2000:]}` —— 两千字符的源码路径、行号和上下文，发给任何
        能触达一个 500 的人。板子绑 0.0.0.0，而且 500 曾经 trivially 可达（`lines=abc`，
        见 _qint）。编号把两边对得上：日志里那一条以同一个编号开头。
        （2026-10-12 review 的 #7）"""
        ref = secrets.token_hex(4)
        sys.stderr.write(f"[workbench] error ref={ref}\n" + traceback.format_exc())
        self._json(500, {"error": "internal error", "ref": ref})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    extra = [p for p in ALSO if p != PORT]
    sys.stderr.write(
        f"[workbench] listening on http://{HOST}:{PORT} (token auth; token in {TOKEN_FILE})"
        + (f" + also {extra} (same process, same state)\n" if extra else "\n")
    )
    # The server is also a worker: its own host is a routable node the engine runs
    # locally, so it is always in the roster even before any client joins. Name it once
    # at startup so the self row's node_ip is visible in the log.
    try:
        _self_ip = state_mod.bridge()._local_node_ip()
        sys.stderr.write(f"[workbench] this host is the server's own worker node "
                         f"{_self_ip} (clients join via POST /api/agents/register)\n")
    except Exception:  # noqa: BLE001 - a logging nicety must never block startup
        pass
    # 副口在守护线程里 serve_forever：主口留在主线程，Ctrl-C / SIGTERM 的行为一个字不变，
    # 副口跟着进程一起走（daemon=True），不会把一个空壳监听留在那儿骗 health 探针。
    for p in extra:
        threading.Thread(target=Server((HOST, p), Handler).serve_forever,
                         name=f"listen-{p}", daemon=True).start()
    Server((HOST, PORT), Handler).serve_forever()
