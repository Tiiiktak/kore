#!/usr/bin/env python3
"""kore-agent — the per-node HTTP agent the server reaches a client node through.

One of these runs on every CLIENT node (a machine that joined with `kore client`). It
gives the server three things over HTTP:

  * run a tmux command on this node   -> POST /exec
  * stream a pane's bytes             -> GET  /tap   (the r/o/g/h/e protocol, verbatim)
  * let the server discover this node -> a heartbeat into the agent registry

Discovery is PUSH: the agent POSTs its own record to the server's register door
(KORE_BRIDGE_URL) every ~15s, so the server never pulls a node list. The server's OWN
node needs no agent — the engine runs those commands locally.

stdlib only — it has to run wherever `claude` and `tmux` already do, with no install.
Threaded by necessity: one /exec and several /tap can be in flight at once.

SECURITY: /exec is arbitrary RCE. KORE_AGENT_TOKEN is the whole fence (a shared secret —
a leak is RCE on this node). Empty token is refused unless bound to localhost.
"""

from __future__ import annotations

import base64
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# ------------------------------------------------------------------------- config

# The agent's listen port. The server must be able to reach it, so a FIXED default makes the
# firewall rule easy to write; if it is taken we fall back to an OS-chosen port (portfile +
# the registered agent_url always say which one). KORE_AGENT_PORT=0 asks for OS-chosen.
DEFAULT_AGENT_PORT = 8199
_port_env = os.environ.get("KORE_AGENT_PORT", "")
KORE_AGENT_PORT = int(_port_env) if _port_env.strip() else DEFAULT_AGENT_PORT
KORE_AGENT_BIND = os.environ.get("KORE_AGENT_BIND", "0.0.0.0")
KORE_AGENT_TOKEN = os.environ.get("KORE_AGENT_TOKEN", "")
# The server's web base URL (e.g. http://10.0.0.7:8198). A client agent POSTs its record
# here every heartbeat; it is REQUIRED — an agent with no server to report to has nothing
# to do, and `kore client` always sets it. There is no shared-file registry fallback.
KORE_BRIDGE_URL = os.environ.get("KORE_BRIDGE_URL", "")
KORE_NODE_IP = os.environ.get("KORE_NODE_IP", "").strip()
TMUX_PREFIX = os.environ.get("KORE_BRIDGE_PREFIX", "kore-")
HEARTBEAT_S = float(os.environ.get("KORE_AGENT_HEARTBEAT_S", "15"))
# Agent-side counterparts of the tap policy keys in koreops' DEFAULT_POLICY. The server
# passes hist/max_bytes per request; these are only the fallbacks and the pull cadence.
TAP_PULL_WAIT_S = float(os.environ.get("KORE_AGENT_TAP_WAIT_S", "2.0"))

STATE_DIR = os.path.expanduser(os.environ.get("KORE_STATE_HOME") or "~/.kore")
# Per-host names: ~/.kore is often on shared storage (NFS/GPFS home), seen by every machine.
_HOST = (socket.gethostname() or "host").split(".")[0]
PORTFILE = os.path.join(STATE_DIR, f"agent-{_HOST}.port")
# Outcome of the latest registration attempt, read by `kore client` / `kore status`.
STATUSFILE = os.path.join(STATE_DIR, f"client-{_HOST}.status")

IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
SESSION_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

STARTED_AT = time.time()


def log(msg: str) -> None:
    print(f"[kore-agent] {msg}", file=sys.stderr, flush=True)


# -------------------------------------------------------------------- node identity


def detect_node_ip() -> str:
    """This host's bridge-reachable egress IP. KORE_NODE_IP is the escape hatch.

    The UDP-connect trick sends no packet — connect() on a datagram socket only picks
    the outbound interface, whose address is the one a peer across the intranet would
    see. gethostbyname is the fallback; loopback only if everything else fails (which is
    a misconfig the registry entry will make visible)."""
    if KORE_NODE_IP and IP_RE.match(KORE_NODE_IP):
        return KORE_NODE_IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        finally:
            s.close()
        if IP_RE.match(ip):
            return ip
    except OSError:
        pass
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if IP_RE.match(ip):
            return ip
    except OSError:
        pass
    return "127.0.0.1"


NODE_IP = detect_node_ip()


def list_kore_sessions() -> list[str]:
    """Local tmux sessions named with the kore- prefix. [] if tmux has no server yet."""
    import subprocess

    try:
        r = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"],
                           capture_output=True, text=True, timeout=10)
    except Exception:  # noqa: BLE001 - no tmux / no server is just "no sessions"
        return []
    if r.returncode != 0:
        return []
    return [ln.strip() for ln in r.stdout.splitlines()
            if ln.strip().startswith(TMUX_PREFIX)]


# ============================================================================ PaneTap
#
# The resident half of the byte stream: it holds one read-only `tmux -C attach -r` on this
# node and turns control-mode notifications into the r/o/g/h/e protocol. Pure stdlib and
# self-contained, so the server can also import it in-process (koreops.agent_mod()) to tap
# its OWN node's panes without going over HTTP — one class, used both over the wire and in
# process, so a pane renders identically whichever node it lives on.


class PaneTap:
    def __init__(self, session: str, hist_lines: int, max_bytes: int):
        import re as _re
        import threading

        self.session = session
        self.hist_lines = int(hist_lines)
        self.max_bytes = int(max_bytes)
        # `%output` escaping: any byte tmux will not put on a line verbatim becomes a
        # backslash and three octal digits. It escapes the backslash itself as \134,
        # which is what makes one non-overlapping pass unambiguous.
        self.octal = _re.compile(rb"\\([0-7]{3})")
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.ev = threading.Event()
        self.proc = None
        self.pane = ""
        self.geom = ""
        self.dead = ""
        self.dropped = 0
        self.recheck = False

    # -- tmux by argv, never a shell string: nothing here is quoted because nothing
    #    here is parsed.
    def _tmux(self, *args, timeout=20):
        import subprocess

        try:
            r = subprocess.run(["tmux", *args], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=timeout)
            return r.returncode, r.stdout, r.stderr
        except Exception as exc:  # noqa: BLE001 - 包括 tmux 根本不在 PATH 上
            return 127, b"", f"{type(exc).__name__}: {exc}".encode()

    def _probe(self):
        """Which pane is on screen, how big, where the cursor is — in one call, so
        the five numbers cannot disagree with each other."""
        rc, out, _ = self._tmux(
            "display-message", "-p", "-t", self.session,
            "#{pane_id} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} "
            "#{?alternate_on,1,0}")
        if rc != 0:
            return None
        f = out.decode("utf8", "replace").split()
        if len(f) != 6:
            return None
        try:
            return {"pane": f[0], "cols": int(f[1]), "rows": int(f[2]),
                    "cx": int(f[3]), "cy": int(f[4]), "alt": f[5] == "1"}
        except ValueError:
            return None

    def _paint(self, pr=None, hist=False):
        """One screenful of bytes that makes an emulator look like the far side.

        A byte stream only tells you what changed *since you connected*; the pane was
        already running. So the first thing down the pipe is a capture: `hist=True`
        replays scrollback as plain lines (it lands in xterm's scrollback the way it
        did over there), then exactly `rows` lines of the visible screen so the
        viewport lines up, then the cursor put back where tmux says it is. `-e` keeps
        the colours. Joined with CRLF because this is going into an emulator, not into
        a file.

        A *re*paint (`hist=False`, after a resize or a dropped backlog) erases the
        viewport and writes the screen in place instead. Replaying history a second
        time would be the easy mistake: the browser already has those lines, and they
        would come back as new ones every time somebody dragged the window.

        Scrollback is skipped for the alternate screen (vim, claude-code's TUI) even
        when asked: there is nothing meaningful to replay there, and the app repaints
        itself.
        """
        pr = pr or self._probe()
        if pr is None:
            return b""
        out = bytearray()
        replayed = False
        if hist and self.hist_lines > 0 and not pr["alt"]:
            rc, old, _ = self._tmux("capture-pane", "-e", "-p", "-t", self.session,
                                    "-S", f"-{self.hist_lines}", "-E", "-1")
            if rc == 0 and old.strip():
                lines = old.split(b"\n")
                if lines and lines[-1] == b"":
                    lines.pop()
                out += b"\r\n".join(lines) + b"\x1b[0m\r\n"
                replayed = True
        if not replayed:
            out += b"\x1b[H\x1b[2J"  # erase the viewport, keep the scrollback
        rc, screen, _ = self._tmux("capture-pane", "-e", "-p", "-t", self.session,
                                   "-S", "0", "-E", "-")
        lines = screen.split(b"\n") if rc == 0 else []
        if lines and lines[-1] == b"":
            lines.pop()
        # Exactly one screenful, padded if tmux trimmed trailing blank lines: the
        # cursor address below is viewport-relative, so a short screen would put the
        # cursor on the wrong row.
        lines = (lines + [b""] * pr["rows"])[:pr["rows"]]
        out += b"\r\n".join(lines) + b"\x1b[0m"
        out += b"\x1b[%d;%dH" % (pr["cy"] + 1, pr["cx"] + 1)
        return bytes(out)

    def _line(self, line: bytes) -> None:
        """One control-mode notification. Everything we do not name here is ignored
        on purpose — control mode gains notifications between tmux versions, and an
        unknown line must never be able to stop the stream."""
        if line.startswith(b"%output "):
            pid, _, payload = line[8:].partition(b" ")
            if self.pane and pid.decode("ascii", "replace") != self.pane:
                return  # another pane in that session is churning; not what we watch
            data = self.octal.sub(lambda m: bytes([int(m.group(1), 8)]), payload)
            with self.lock:
                self.buf += data
                if len(self.buf) > self.max_bytes:
                    # Never truncate a byte stream in the middle: half an escape
                    # sequence corrupts the emulator for good. Drop the backlog and
                    # let pull() repaint from a capture instead.
                    self.dropped += len(self.buf)
                    self.buf = bytearray()
            self.ev.set()
        elif line.startswith((b"%layout-change", b"%window-pane-changed",
                              b"%session-window-changed", b"%window-add")):
            self.recheck = True
            self.ev.set()
        elif line.startswith((b"%exit", b"%session-closed", b"%unlinked-window-close")):
            self.dead = self.dead or "对面的 tmux 说 %exit —— session 关了或者被 kill 了"
            self.ev.set()

    def _pump(self):
        """The reader thread: blocking read, line framing, nothing else. It must not
        raise — a dead pump with a live actor is a stream that hangs instead of
        saying why, so every exit path writes `self.dead` first."""
        import os as _os

        rest = b""
        fd = self.proc.stdout.fileno()
        while True:
            try:
                chunk = _os.read(fd, 65536)
            except Exception as exc:  # noqa: BLE001
                self.dead = f"读 tmux -C 的管子炸了: {type(exc).__name__}: {exc}"
                break
            if not chunk:
                self.dead = self.dead or "tmux -C 的管子到头了（对面 detach 或 tmux 退了）"
                break
            rest += chunk
            while b"\n" in rest:
                line, rest = rest.split(b"\n", 1)
                try:
                    self._line(line.rstrip(b"\r"))
                except Exception as exc:  # noqa: BLE001
                    self.dead = f"这行控制模式没看懂: {type(exc).__name__}: {exc}"
        self.ev.set()

    def start(self):
        """Attach, then paint, then throw away whatever arrived in between.

        That order is the point: paint-then-attach would lose every byte the pane
        produced in the gap, and those bytes are gone for good. Attaching first can
        only produce the opposite problem — bytes that are *also* in the capture — and
        those we can simply drop, which is what the buffer clear below does.
        """
        import subprocess
        import threading

        pr = self._probe()
        if pr is None:
            return {"ok": False,
                    "error": f"问不出 {self.session} 的 pane —— session 不在那个节点上？"}
        try:
            self.proc = subprocess.Popen(
                ["tmux", "-C", "attach", "-r", "-t", self.session],
                # `-r` is the read-only flag and it is load-bearing: measured, an
                # `attach -r` does NOT resize the far window, while a plain attach
                # makes that window follow this client. stdin is a pipe we never
                # write to and never close — closing it would EOF the control client.
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, bufsize=0)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"起不来 tmux -C: {type(exc).__name__}: {exc}"}
        threading.Thread(target=self._pump, daemon=True).start()
        pr = self._probe() or pr
        self.pane, self.geom = pr["pane"], f"{pr['cols']}x{pr['rows']}"
        paint = self._paint(pr, hist=True)
        with self.lock:
            self.buf = bytearray()
            self.dropped = 0
        self.ev.clear()
        return {"ok": True, "pane": self.pane, "cols": pr["cols"], "rows": pr["rows"],
                "paint": paint, "pid": self.proc.pid, "dead": self.dead}

    def pull(self, max_wait: float = 2.0):
        """Blocking read of the backlog: bytes come back the instant they exist, and
        an empty answer means `max_wait` of genuine quiet. This is the call that
        replaces the tick — there is no interval anywhere in this path."""
        import time as _t

        if not self.buf and not self.dead and not self.recheck:
            self.ev.wait(max_wait)
        self.ev.clear()
        geom, paint = "", b""
        if self.recheck:
            self.recheck = False
            pr = self._probe()
            if pr is not None:
                g = f"{pr['cols']}x{pr['rows']}"
                if pr["pane"] != self.pane or g != self.geom:
                    # A different pane, or the same pane at a different size: the
                    # bytes we are holding were computed against the old screen.
                    self.pane, self.geom, geom = pr["pane"], g, g
                    paint = self._paint(pr)
        with self.lock:
            out, self.buf = bytes(self.buf), bytearray()
            dropped, self.dropped = self.dropped, 0
        if dropped and not paint:
            paint, geom = self._paint(), self.geom
        if paint:
            out = b""  # the whole screen is in `paint`; replaying old bytes after it
                       # is how you get a garbled one
        return {"bytes": paint or out, "geom": geom, "dead": self.dead,
                "dropped": dropped, "at": _t.time()}

    def close(self):
        try:
            if self.proc is not None:
                self.proc.terminate()
        except Exception:  # noqa: BLE001
            pass
        self.dead = self.dead or "closed"
        self.ev.set()
        return True


# ===================================================================== agent registry
#
# A client has exactly one way to appear in the roster: POST its own record to the
# server's register door every heartbeat. The server keeps one key per node_ip (under its
# own file lock) and stamps its own clock on `last_seen`, so a node with a skewed clock
# cannot age itself out early. We never delete anyone's key — a reader prunes by TTL, so a
# single missed beat is survivable (flap-safe).


def _my_record(port: int) -> dict:
    return {"agent_url": f"http://{NODE_IP}:{port}", "last_seen": time.time(),
            "started_at": STARTED_AT, "pid": os.getpid(), "sessions": list_kore_sessions(),
            "hostname": socket.gethostname()}


class RegisterRejected(RuntimeError):
    """The server refused our token (HTTP 401/403): retrying cannot help."""


def _write_status(**kw) -> None:
    """Record the latest registration outcome for `kore client` / `kore status`."""
    rec = {"at": time.time(), "pid": os.getpid(), "node_ip": NODE_IP,
           "server": KORE_BRIDGE_URL, **kw}
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = f"{STATUSFILE}.tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, STATUSFILE)
    except OSError:
        pass


def publish(port: int) -> dict:
    """One heartbeat: POST our record to the server. Returns the server's answer (which
    includes whether the server could reach us back). Raises on failure; RegisterRejected
    when the token is refused."""
    return _register_via_bridge(_my_record(port))


def _register_via_bridge(rec: dict) -> dict:
    import urllib.error
    import urllib.request

    body = json.dumps({"node_ip": NODE_IP, **rec}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if KORE_AGENT_TOKEN:
        headers["Authorization"] = "Bearer " + KORE_AGENT_TOKEN
    req = urllib.request.Request(KORE_BRIDGE_URL.rstrip("/") + "/api/agents/register",
                                 data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=10) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise RegisterRejected(f"server rejected the token (HTTP {exc.code})") from None
        raise
    try:
        ans = json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        ans = {}
    return ans if isinstance(ans, dict) else {}


def unpublish() -> None:
    """Nothing to do on the way out: the server TTL-prunes a client whose heartbeats stop,
    and it exposes no un-register door. Kept as the shutdown hook's no-op seam."""
    return


def beat(port: int) -> bool:
    """One heartbeat with its outcome recorded. False only when the token was rejected
    (the caller then shuts down: retrying a wrong token forever helps nobody)."""
    try:
        ans = publish(port)
    except RegisterRejected as exc:
        log(f"REGISTRATION REFUSED by {KORE_BRIDGE_URL}: {exc}. Check --token.")
        _write_status(ok=False, rejected=True, error=str(exc))
        return False
    except Exception as exc:  # noqa: BLE001 - transient: keep beating
        log(f"heartbeat to {KORE_BRIDGE_URL} failed: {exc!r}")
        _write_status(ok=False, rejected=False, error=f"{type(exc).__name__}: {exc}")
        return True
    _write_status(ok=True, agent_url=f"http://{NODE_IP}:{port}",
                  reachable=ans.get("reachable"), reach_error=ans.get("reach_error", ""))
    return True


def heartbeat_loop(port: int, stop: threading.Event, on_rejected) -> None:
    while not stop.wait(HEARTBEAT_S):
        if not beat(port):
            on_rejected()
            return


# ============================================================================= HTTP


def _exec(cmd: str, timeout: int) -> dict:
    import subprocess

    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return {"stdout": r.stdout, "stderr": r.stderr, "rc": r.returncode}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"command timed out after {timeout}s", "rc": 124}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 - quiet; our own log() is enough
        return

    # -- auth ---------------------------------------------------------------------
    def _bearer(self) -> bool:
        h = self.headers.get("Authorization", "")
        return h.startswith("Bearer ") and h[7:].strip() == KORE_AGENT_TOKEN

    def _authed(self, query: dict, *, allow_query: bool) -> bool:
        """Empty token => auth off (startup already refused that off localhost). /exec
        passes allow_query=False (Bearer only); /tap and the GETs accept ?token= too,
        because a stream client (EventSource-style) cannot always set a header."""
        if not KORE_AGENT_TOKEN:
            return True
        if self._bearer():
            return True
        if allow_query:
            return any(t == KORE_AGENT_TOKEN for t in query.get("token", []))
        return False

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _deny(self) -> None:
        self._json(401, {"ok": False, "error": "unauthorized: kore-agent token required"})

    # -- GET: /ping /sessions /tap ------------------------------------------------
    def do_GET(self):  # noqa: N802
        parts = urlsplit(self.path)
        q = parse_qs(parts.query)
        if parts.path in ("/ping", "/sessions"):
            if not self._authed(q, allow_query=True):
                return self._deny()
            self._json(200, {"ok": True, "node_ip": NODE_IP, "pid": os.getpid(),
                             "started_at": STARTED_AT, "sessions": list_kore_sessions()})
            return
        if parts.path == "/tap":
            if not self._authed(q, allow_query=True):
                return self._deny()
            self._tap(q)
            return
        self._json(404, {"ok": False, "error": f"no endpoint {parts.path!r}"})

    # -- POST: /exec --------------------------------------------------------------
    def do_POST(self):  # noqa: N802
        parts = urlsplit(self.path)
        if parts.path != "/exec":
            return self._json(404, {"ok": False, "error": f"no endpoint {parts.path!r}"})
        if not self._authed({}, allow_query=False):
            return self._deny()
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return self._json(400, {"ok": False, "error": f"bad JSON: {exc}"})
        if not isinstance(body, dict) or not isinstance(body.get("cmd"), str):
            return self._json(400, {"ok": False, "error": "body needs a string 'cmd'"})
        timeout = int(body.get("timeout") or 30)
        self._json(200, _exec(body["cmd"], timeout))

    # -- the tap: r/o/g/h/e over HTTP/1.1 chunked text/plain ----------------------
    def _tap(self, q: dict) -> None:
        session = (q.get("session") or [""])[0]
        if not SESSION_NAME_RE.match(session):
            return self._json(400, {"ok": False,
                                    "error": f"bad session name {session!r}"})
        hist = int((q.get("hist") or ["400"])[0] or "400")
        max_bytes = int((q.get("max_bytes") or ["262144"])[0] or "262144")

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")  # no proxy may batch the frames
        self.end_headers()

        pane = PaneTap(session, hist, max_bytes)
        last_beat = time.time()

        def emit(kind: str, payload: str = "") -> bool:
            """One protocol line as one HTTP chunk, flushed. False => the reader is gone
            (BrokenPipe) — the pipe is the liveness signal, exactly as in koreops._tap_say."""
            line = (f"{kind} {payload}\n" if payload else f"{kind}\n").encode("utf-8")
            try:
                self.wfile.write(b"%X\r\n" % len(line) + line + b"\r\n")
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
                return False

        try:
            res = pane.start()
            if not res.get("ok"):
                emit("e", str(res.get("error") or "attach 失败，没说为什么"))
                return
            if not emit("r", f"{res['cols']}x{res['rows']}"):
                return
            if res.get("paint") and not emit(
                    "o", base64.b64encode(res["paint"]).decode("ascii")):
                return
            while True:
                got = pane.pull(TAP_PULL_WAIT_S)
                if got.get("geom") and not emit("g", got["geom"]):
                    return
                data = got.get("bytes") or b""
                if data:
                    if not emit("o", base64.b64encode(data).decode("ascii")):
                        return
                    last_beat = time.time()
                elif not got.get("dead"):
                    # The heartbeat is NOT optional: it is what makes teardown prompt on a
                    # quiet pane. A reader that has gone away turns the next write into a
                    # broken pipe, and that is the only thing that tears this down.
                    if time.time() - last_beat >= 2.0:
                        if not emit("h", f"{time.time():.3f}"):
                            return
                        last_beat = time.time()
                if got.get("dead"):
                    emit("e", str(got["dead"]))
                    return
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        except Exception as exc:  # noqa: BLE001
            emit("e", f"{type(exc).__name__}: {exc}")
        finally:
            # The browser closed -> the bridge closed its response -> our next write got
            # BrokenPipe -> here. Closing the pane kills the local `tmux -C attach -r`, so
            # the thing this stream borrowed is gone now, not whenever something notices.
            pane.close()
            try:
                self.wfile.write(b"0\r\n\r\n")  # terminating chunk, best effort
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
                pass


# ============================================================================== main


def _write_portfile(port: int) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = f"{PORTFILE}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(str(port))
    os.replace(tmp, PORTFILE)


def main() -> int:
    if not KORE_BRIDGE_URL:
        log("REFUSING to start: KORE_BRIDGE_URL is unset — a client agent has no server to "
            "report to. Join with `kore client --server <ip:port> --token <tok>`, which sets "
            "it for you; there is no default and no shared-file fallback.")
        return 2
    local_only = KORE_AGENT_BIND in ("127.0.0.1", "localhost", "::1")
    if not KORE_AGENT_TOKEN and not local_only:
        log(f"REFUSING to start: KORE_AGENT_TOKEN is empty and bind is {KORE_AGENT_BIND!r} "
            f"(/exec would be unauthenticated RCE). Set KORE_AGENT_TOKEN, or bind "
            f"KORE_AGENT_BIND=127.0.0.1 for a deliberately local-only agent.")
        return 2
    if not KORE_AGENT_TOKEN:
        log("WARNING: KORE_AGENT_TOKEN is empty — auth is OFF (bound to localhost only).")

    try:
        httpd = ThreadingHTTPServer((KORE_AGENT_BIND, KORE_AGENT_PORT), Handler)
    except OSError as exc:
        if not _port_env.strip() and KORE_AGENT_PORT == DEFAULT_AGENT_PORT:
            # The default port is taken (another agent, or anything else): fall back to an
            # OS-chosen one rather than fail. An explicit KORE_AGENT_PORT is honoured strictly.
            log(f"port {DEFAULT_AGENT_PORT} unavailable ({exc}); using an OS-chosen port")
            httpd = ThreadingHTTPServer((KORE_AGENT_BIND, 0), Handler)
        else:
            raise
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    _write_portfile(port)
    log(f"listening on {KORE_AGENT_BIND}:{port} (node_ip={NODE_IP}, "
        f"url=http://{NODE_IP}:{port}, auth={'on' if KORE_AGENT_TOKEN else 'OFF'})")

    stop = threading.Event()
    # Serve FIRST, then register: the server probes this agent back while answering the
    # registration (to tell the user whether server -> client works), so the agent must
    # already be answering requests when the first POST goes out.
    threading.Thread(target=httpd.serve_forever, daemon=True, name="kore-agent-http").start()

    def _shutdown(signum, frame):  # noqa: ARG001
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _shutdown)
        except (ValueError, OSError):
            pass

    # Seed the registration before the first heartbeat interval elapses. A refused token is
    # final (exit 3); any other failure is transient and the heartbeat keeps retrying.
    rc = 0
    if beat(port):
        threading.Thread(target=heartbeat_loop, args=(port, stop, stop.set), daemon=True,
                         name="kore-agent-heartbeat").start()
        while not stop.wait(1.0):
            pass
        if os.path.exists(STATUSFILE) and _rejected_now():
            rc = 3
    else:
        rc = 3
    httpd.shutdown()
    httpd.server_close()
    try:
        unpublish()
    except Exception:  # noqa: BLE001
        pass
    return rc


def _rejected_now() -> bool:
    try:
        with open(STATUSFILE) as f:
            d = json.load(f)
        return bool(d.get("rejected")) and d.get("pid") == os.getpid()
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    sys.exit(main())
