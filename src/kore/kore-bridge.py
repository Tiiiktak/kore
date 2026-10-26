#!/usr/bin/env python3
"""kore MCP server — exposes worker-node Claude Code sessions to an MCP client.

Mechanism: a "kore session" is a tmux session named `kore-<name>` on a node, running
the interactive Claude Code CLI. We drive it with `tmux send-keys` and read it with
`tmux capture-pane`, inferring busy/waiting/idle from the CLI's own UI strings.

Routing is per node and needs no configuration: a command for THIS host (the server's
own node) runs here directly with `subprocess`; a command for any other node is POSTed
to that node's kore-agent over HTTP. The server is therefore also a worker — a single
machine needs nothing but the server itself, and extra nodes join as clients whose
agents register into the roster.

Transport: MCP over stdio. stdout carries protocol JSON only; diagnostics go to
stderr.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
import threading
import time
from typing import Any

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "kore"
SERVER_VERSION = "0.1.0"

TMUX_PREFIX = os.environ.get("KORE_BRIDGE_PREFIX", "kore-")
REGISTRY_FILE = os.path.expanduser(os.environ.get("KORE_REGISTRY", "~/.kore/sessions.json"))
MAX_OUTPUT_CHARS = int(os.environ.get("KORE_MAX_OUTPUT_CHARS", "20000"))

# --------------------------------------------------------------------- routing
# How this engine reaches a node. There is no switch: `sh()` decides per node. A command
# for THIS host (the server's own node, see _local_node_ip) runs here with subprocess; a
# command for any other node is POSTed to that node's kore-agent /exec. So the server is
# also a worker, and the cluster is "self + whatever clients have registered".
#
# The node_ip -> agent-url registry. SEPARATE from REGISTRY_FILE (the name -> node_ip
# *session* registry above): that one maps a session to where it lives, this one maps a
# node to the HTTP agent that reaches it. A client's kore-agent writes it (by POSTing to
# the server's register door); the engine only ever reads it.
KORE_AGENTS_FILE = os.path.expanduser(
    os.environ.get("KORE_AGENTS_FILE", "~/.kore/agents.json"))
# How long an agent's registry entry is trusted after its last heartbeat. Generous on
# purpose (heartbeat ~15s): a node that flaps for one missed beat must not vanish from
# the roster. Readers filter by this; nobody deletes a stale entry (flap-safe).
KORE_AGENT_TTL = float(os.environ.get("KORE_AGENT_TTL", "45"))
# Shared secret the engine presents to a client agent's /exec and /tap. Empty = auth
# off, which an agent refuses unless it is bound to localhost. A leaked token is
# arbitrary RCE on every node, so it is the whole structural fence in front of /exec.
KORE_AGENT_TOKEN = os.environ.get("KORE_AGENT_TOKEN", "")
# Override node-ip autodetect (the egress IP a peer would reach this host by). Read by
# _local_node_ip here and by kore-agent on the node; the escape hatch when autodetect
# picks the wrong interface.
KORE_NODE_IP = os.environ.get("KORE_NODE_IP", "").strip()

# Legacy "Claude Code is working" strings. Current Claude Code no longer prints most of them;
# pane_state() uses them only as a fallback and only on the last lines of the pane.
BUSY_MARKERS = ("esc to interrupt", "Topsy-turvying", "Thinking", "esc to cancel", "Generating")
READY_MARKERS = ("bypass permissions", "Welcome back", "for getting started", "What can I help", ">")
CHROME_MARKERS = (
    "───", "━━━", "bypass permissions", "new task?", "/clear to save",
    "shift+tab", "← for agents", "⏵⏵",
)

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]")
IP_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
SESSION_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
TMUX_KEY_RE = re.compile(r"^[A-Za-z0-9-]{1,16}$")

_stdout_lock = threading.Lock()
_session_locks: dict[str, threading.Lock] = {}
_session_locks_guard = threading.Lock()


def log(msg: str) -> None:
    print(f"[kore-bridge] {msg}", file=sys.stderr, flush=True)


def validate_ip(ip: str) -> str:
    if not IP_RE.match(ip or ""):
        raise ValueError(f"invalid node IP: {ip!r}")
    if not all(0 <= int(p) <= 255 for p in ip.split(".")):
        raise ValueError(f"IP octets out of range: {ip!r}")
    return ip


def norm_name(name: str) -> str:
    raw = name if name.startswith(TMUX_PREFIX) else TMUX_PREFIX + name
    if not SESSION_NAME_RE.match(raw):
        raise ValueError(f"invalid session name: {name!r} (alphanumeric, - and _ only, <=64 chars)")
    return raw


def quote_path(p: str) -> str:
    """Quote a path for a remote shell while keeping a leading `~` expandable.

    Plain `shlex.quote("~")` yields `'~'`, which no shell expands, so the default
    cwd would break. `~/x` becomes `"$HOME"'/x'`: $HOME still expands, the rest is
    literal, and nothing a caller supplies can end the quoting early.
    """
    if p == "~":
        return '"$HOME"'
    if p.startswith("~/"):
        return '"$HOME"' + shlex.quote("/" + p[2:])
    return shlex.quote(p)


def validate_key(key: str) -> str:
    """tmux key names only. `key` is interpolated into a remote command, and every
    real tmux key (Enter, Escape, C-c, M-x, PageUp, F1, BSpace…) fits this shape, so
    anything else is a caller trying to append a second command."""
    if not TMUX_KEY_RE.match(key or ""):
        raise ValueError(f"invalid tmux key: {key!r} (letters, digits and - only, <=16 chars)")
    return key


def session_lock(node_ip: str, name: str) -> threading.Lock:
    """Serialize commands per session so concurrent sends cannot interleave keystrokes."""
    key = f"{node_ip}/{name}"
    with _session_locks_guard:
        lock = _session_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _session_locks[key] = lock
        return lock


def sh(node_ip: str, cmd: str, timeout: int = 30) -> dict[str, Any]:
    """Run one shell command "on node_ip" and return {stdout, stderr, rc}.

    The single chokepoint every kore_* verb and every koreops read/write ultimately funnels
    through, which is why routing lives here and nowhere else. The decision is per node and
    needs no configuration: the server's OWN node runs locally; any other node is reached
    over HTTP. Both backends honour the SAME contract — a dict with exactly stdout/stderr/rc
    — so callers (kore_start's `"OK" in stdout`, node_run's `rc`) never learn which ran it.
    """
    if node_ip == _local_node_ip():
        return _sh_local(node_ip, cmd, timeout)
    return _sh_http(node_ip, cmd, timeout)


def _sh_local(node_ip: str, cmd: str, timeout: int = 30) -> dict[str, Any]:
    """Self node: run right here with subprocess (`node_ip` is this host)."""
    import subprocess  # noqa: PLC0415 - kept local to the backend that uses it

    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return {"stdout": r.stdout, "stderr": r.stderr, "rc": r.returncode}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"command timed out after {timeout}s", "rc": 124}


def _sh_http(node_ip: str, cmd: str, timeout: int = 30) -> dict[str, Any]:
    """HTTP mode: POST /exec on the node's kore-agent. The agent runs the same
    `subprocess.run(shell=True)` _sh_local does and returns the same shape, so the only
    difference from local is which host the shell runs on."""
    validate_ip(node_ip)
    url = resolve_agent_url(node_ip)
    r = _agent_post(url, "/exec", {"cmd": cmd, "timeout": timeout}, timeout + 15)
    if not isinstance(r, dict):
        raise RuntimeError(f"agent {url} /exec returned non-JSON-object: {r!r:.120}")
    return {"stdout": r.get("stdout", ""), "stderr": r.get("stderr", ""),
            "rc": int(r.get("rc", 0))}


# ----------------------------------------------------------------- HTTP transport
#
# stdlib urllib only — the engine stays import-light and a client agent is reached over a
# plain socket. A public HTTP proxy would break a direct node connection, so the opener is
# built with an empty ProxyHandler, i.e. proxies off entirely for agent traffic.

_agent_opener = None
_agent_opener_lock = threading.Lock()


def _opener():
    global _agent_opener
    if _agent_opener is not None:
        return _agent_opener
    with _agent_opener_lock:
        if _agent_opener is None:
            import urllib.request  # noqa: PLC0415

            _agent_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return _agent_opener


def _agent_request(url: str, path: str, *, data: bytes | None = None,
                   query: dict[str, Any] | None = None, timeout: float = 45.0):
    """Build + open one request to an agent, bypassing proxies and carrying the token.

    Returns the open response object; the caller reads it (and closes it). POSTs pass
    `data`; streams pass `query`. The token rides as a Bearer header on every call."""
    import urllib.parse  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    full = url.rstrip("/") + path
    if query:
        full += "?" + urllib.parse.urlencode(query)
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if KORE_AGENT_TOKEN:
        headers["Authorization"] = "Bearer " + KORE_AGENT_TOKEN
    req = urllib.request.Request(full, data=data, headers=headers,
                                 method="POST" if data is not None else "GET")
    return _opener().open(req, timeout=timeout)


def _agent_post(url: str, path: str, body: dict[str, Any], timeout: float = 45.0) -> Any:
    """POST a JSON body to an agent and return the parsed JSON response."""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    with _agent_request(url, path, data=data, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _agent_stream(url: str, path: str, query: dict[str, Any], timeout: float = 6.0):
    """Open a streaming GET and hand back the raw response for line iteration.

    `timeout` becomes the socket timeout, so it is also the per-line READ timeout: once
    the agent goes silent for this long a `.readline()` raises socket.timeout, which is
    exactly the "agent went quiet" signal the tap relay turns into an `e`. Set it to a
    few heartbeats so a normal quiet pane (one `h` every ~2s) never trips it."""
    return _agent_request(url, path, query=query, timeout=timeout)


# ------------------------------------------------------------------ pane helpers


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text or "")
    lines = [ln.rstrip() for ln in text.splitlines()]
    while lines and not lines[-1]:
        lines.pop()
    out = "\n".join(lines)
    if len(out) > MAX_OUTPUT_CHARS:
        keep = MAX_OUTPUT_CHARS - 80
        out = f"...[clipped {len(out) - keep} earlier chars]...\n" + out[-keep:]
    return out


# --- session state detection -------------------------------------------------------------
# States: "busy" (Claude is working / retrying), "waiting" (Claude is blocked on a user
# choice: permission prompt, AskUserQuestion menu), "idle" (finished, prompt is free).
# Only the bottom of the pane counts: a stale spinner or marker far up the scrollback
# must never make a finished session look busy.
STATE_TAIL_LINES = 15
_SPIN = r"[✻✽✢✶✳✺✹✷✸*·•+✦◆]"
# Live spinner: "✻ Working… (27s · ↓ 1.5k tokens)", "* Cogitating… (12s · esc to interrupt)".
# The verb is random, so match the shape: glyph, words, ellipsis, "(" with a duration or
# the interrupt hint.
_ACTIVE_RE = re.compile(
    _SPIN + r"\s+\S[^\n]*?(?:…|\.\.\.)\s*\((?=[^)\n]*(?:\b\d+\s*[hms]\b|esc to interrupt))"
)
_RETRY_RE = re.compile(r"Waiting for API response|will retry in\b|Retrying in\b", re.I)
# Finished: "✻ Churned for 2m 13s · done 7:13 PM", "Baked for 40s".
_PAST_RE = re.compile(r"^\s*(?:" + _SPIN + r"\s+)?[A-Z][a-z-]+ed for \d+\s*[hms]\b|·\s*done\b")
# Choice menus: "❯ 1. Yes", "│ ❯ 1. Yes", plus the prompt captions around them.
_OPTION_CUR_RE = re.compile(r"^[\s│|]*❯\s*\d+[.)]\s+\S")
_OPTION_RE = re.compile(r"^[\s│|]*(?:❯\s*)?\d+[.)]\s+\S")
_ASK_RE = re.compile(
    r"Do you want to|Would you like to|Enter to select|↑/↓ to navigate|"
    r"Esc to cancel|Tab to amend|don't ask again", re.I)
# The empty input box Claude Code shows when it accepts free text ("❯ " on its own).
_EMPTY_PROMPT_RE = re.compile(r"^[\s│|]*[❯>]\s*$")
_RULE_RE = re.compile(r"^[\s─━╭╰│]*[─━]{8,}")


def _tail_lines(pane: str) -> list[str]:
    """Last STATE_TAIL_LINES non-empty lines of the pane, ANSI-stripped.

    The window is anchored on the input box when one is visible, so a long footer under
    it (subagent list, status lines) cannot push the spinner line out of the window."""
    lines = [ln.rstrip() for ln in ANSI_RE.sub("", pane or "").splitlines() if ln.strip()]
    end = len(lines)
    for i in range(len(lines) - 1, max(-1, len(lines) - 40), -1):
        if _EMPTY_PROMPT_RE.match(lines[i]) and i > 0 and _RULE_RE.match(lines[i - 1]):
            end = i + 1  # include the box itself; lines below are footer chrome
            break
    tail = lines[max(0, end - STATE_TAIL_LINES):end]
    return tail + lines[end:]


def pane_state(pane: str) -> str:
    """Classify a Claude Code pane as "busy", "waiting" or "idle" (see the block comment)."""
    tail = _tail_lines(pane)
    # waiting: a numbered choice menu with its cursor, and no free input box under it.
    for i in range(len(tail) - 1, -1, -1):
        ln = tail[i]
        if _EMPTY_PROMPT_RE.match(ln):
            break  # an empty input box below anything else means Claude takes free text
        if _OPTION_CUR_RE.match(ln):
            opts = sum(1 for x in tail if _OPTION_RE.match(x))
            if opts >= 2 or any(_ASK_RE.search(x) for x in tail):
                return "waiting"
    # busy / idle: the bottom-most status line decides.
    for ln in reversed(tail):
        if _RETRY_RE.search(ln) or _ACTIVE_RE.search(ln):
            return "busy"
        if _PAST_RE.search(ln):
            return "idle"
    # Legacy markers as a fallback signal, but only inside the tail window.
    if any(m in ln for ln in tail for m in BUSY_MARKERS):
        return "busy"
    return "idle"


def is_busy(pane: str) -> bool:
    return pane_state(pane) == "busy"


# --- hook-driven state (preferred over the scraper above) --------------------------------
# kore-agent's Claude Code hooks drop a per-session file on the node; the node is the agent's
# own host, so we fetch these over the same sh()/`/exec` path we use for everything else. A
# session with a usable hook record takes that state; anything else (adopted/pre-hook
# sessions, or a node where hooks aren't installed) falls back to pane_state() scraping.
_AGENT_STATE_GLOB = "~/.kore/agent-state"


def node_hook_states(node_ip: str) -> dict[str, dict]:
    """All of a node's hook state records, {session_name: record}, in one round-trip."""
    cmd = (f'for f in {_AGENT_STATE_GLOB}/*.json; do [ -e "$f" ] || continue; '
           'printf "%s\\t" "$(basename "$f" .json)"; tr -d "\\n" < "$f"; printf "\\n"; done')
    out: dict[str, dict] = {}
    try:
        r = sh(node_ip, cmd, 20)
    except Exception:  # noqa: BLE001 - never let a missing/odd state dir break the roster
        return out
    for line in (r.get("stdout") or "").splitlines():
        if "\t" not in line:
            continue
        name, js = line.split("\t", 1)
        try:
            rec = json.loads(js)
            if isinstance(rec, dict):
                out[name] = rec
        except (json.JSONDecodeError, ValueError):
            pass
    return out


# System metrics for the overview dashboard: load / cpu / mem / disk / gpu, collected in ONE
# round trip per node (same shape as node_hook_states). Everything is best-effort — a missing
# file or tool just omits that field, never fails the call. $HOME picks the disk the user's
# sessions actually live on. nvidia-smi is optional (no GPU / not installed -> empty list).
_SYS_METRICS_CMD = (
    'echo "LOAD $(cat /proc/loadavg 2>/dev/null)"; '
    'echo "CPUS $(nproc 2>/dev/null || echo 0)"; '
    'echo "MEM $(awk \'/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}\' /proc/meminfo 2>/dev/null)"; '
    'echo "DISK $(df -P -k "$HOME" 2>/dev/null | awk \'NR==2{print $3, $2}\')"; '
    'echo "KVER $(kore --version 2>/dev/null | awk \'{print $NF}\')"; '
    'echo GPU_START; '
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total '
    '--format=csv,noheader,nounits 2>/dev/null; echo GPU_END')


def node_system_metrics(node_ip: str) -> dict:
    """One node's {load1/5/15, cpus, mem_used_kb, mem_total_kb, disk_used_kb, disk_total_kb,
    gpus:[{util,mem_used,mem_total}]} in a single sh(). {} (not an error) when unreachable."""
    try:
        r = sh(node_ip, _SYS_METRICS_CMD, 15)
    except Exception:  # noqa: BLE001 - a slow/absent node must not break the whole sweep
        return {}
    out: dict = {}
    gpus: list[dict] = []
    in_gpu = False
    for line in (r.get("stdout") or "").splitlines():
        line = line.strip()
        if line == "GPU_START":
            in_gpu = True
            continue
        if line == "GPU_END":
            in_gpu = False
            continue
        if in_gpu:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 3:
                try:
                    gpus.append({"util": int(float(parts[0])), "mem_used": int(float(parts[1])),
                                 "mem_total": int(float(parts[2]))})
                except ValueError:
                    pass
            continue
        tag, _, rest = line.partition(" ")
        f = rest.split()
        try:
            if tag == "LOAD" and len(f) >= 3:
                out["load1"], out["load5"], out["load15"] = (float(f[0]), float(f[1]), float(f[2]))
            elif tag == "CPUS" and f:
                out["cpus"] = int(f[0])
            elif tag == "MEM" and len(f) >= 2:
                out["mem_total_kb"], out["mem_avail_kb"] = int(f[0]), int(f[1])
            elif tag == "DISK" and len(f) >= 2:
                out["disk_used_kb"], out["disk_total_kb"] = int(f[0]), int(f[1])
            elif tag == "KVER" and f:
                out["kore_version"] = f[0]
        except ValueError:
            pass
    out["gpus"] = gpus
    return out


def _read_hook_state(node_ip: str, name: str) -> dict | None:
    try:
        r = sh(node_ip, f"cat {_AGENT_STATE_GLOB}/{name}.json 2>/dev/null || true", 15)
    except Exception:  # noqa: BLE001
        return None
    txt = (r.get("stdout") or "").strip()
    if not txt:
        return None
    try:
        rec = json.loads(txt)
        return rec if isinstance(rec, dict) else None
    except (json.JSONDecodeError, ValueError):
        return None


def session_state(node_ip: str, name: str, pane: str,
                  states: dict[str, dict] | None = None) -> str:
    """kore state for a session: the hook record if it has one, else the pane scraper.

    Pass `states` (from node_hook_states) to classify a whole roster with one round-trip;
    omit it to fetch this one session's record on demand (the wait loop / single reads)."""
    rec = states.get(name) if states is not None else _read_hook_state(node_ip, name)
    st = rec.get("state") if rec else None
    if st in ("busy", "waiting", "idle"):
        ps = pane_state(pane)
        # Hooks fire only on transitions, so a missed one freezes the record. The scraper can
        # correct it in the two directions it provably gets right:
        #   idle/busy -> waiting: a choice/permission menu (AskUserQuestion) is up. The hook may
        #     still read busy (an in-turn question) or idle (a Stop fired with the menu left up).
        if st != "waiting" and ps == "waiting":
            return "waiting"
        #   idle -> busy: a live spinner is running, so Claude is plainly working even though the
        #     last hook we saw was idle — e.g. a long turn whose UserPromptSubmit/Stop hook never
        #     fired, or an adopted / pre-hook session frozen at SessionStart. A finished prompt
        #     scrapes as idle (past-tense marker, no live spinner), so this never makes a done
        #     session look busy.
        if st == "idle" and ps == "busy":
            return "busy"
        return st
    return pane_state(pane)   # ended / missing / unparsable -> fall back to scraping


def mark_busy(node_ip: str, name: str) -> None:
    """Optimistically flip a session to busy the instant we deliver input (cmux's
    afterExplicitInput), so the dot reacts without waiting for the UserPromptSubmit hook.
    `name` is norm_name-validated (alnum/_/-), so it is safe to interpolate into the path."""
    try:
        sh(node_ip,
           f'mkdir -p {_AGENT_STATE_GLOB} && t=$(date +%s) && '
           'printf \'{"state":"busy","since":%s,"event":"kore-input","ts":%s}\' "$t" "$t" '
           f'> {_AGENT_STATE_GLOB}/{name}.json',
           15)
    except Exception:  # noqa: BLE001 - best-effort; the real hooks are authoritative
        pass


def has_session(node_ip: str, name: str) -> bool:
    # `=` forces an EXACT match. Without it tmux treats the target as a PREFIX, so
    # `has-session -t kore-test` matches an existing `kore-test-hook` — which both falsely
    # reports "already exists" on start and would let send/stop act on the WRONG session.
    # `name` is norm_name'd (SESSION_NAME_RE: letters/digits/-/_), so it needs no quoting.
    r = sh(node_ip, f"tmux has-session -t ={name} 2>/dev/null && echo YES || echo NO", 20)
    return "YES" in r["stdout"]


def capture(node_ip: str, name: str, lines: int = 120) -> str:
    return sh(node_ip, f"tmux capture-pane -t {name} -p -S -{lines}", 20)["stdout"]


def send_keys(node_ip: str, name: str, literal: str | None = None, key: str | None = None) -> None:
    if key:
        sh(node_ip, f"tmux send-keys -t {name} {validate_key(key)}", 20)
    else:
        escaped = (literal or "").replace("'", "'\\''")
        sh(node_ip, f"tmux send-keys -t {name} '{escaped}'", 20)


def summarize(node_ip: str, name: str) -> str:
    """Last few substantive lines, skipping Claude Code's UI chrome — the roster's 'what is it doing'."""
    try:
        lines = clean(capture(node_ip, name, 80)).splitlines()
        picked: list[str] = []
        for line in reversed(lines):
            s = line.strip()
            if not s or s in ("❯", ">", "$"):
                continue
            if any(m in s for m in CHROME_MARKERS):
                continue
            picked.append(s)
            if len(picked) >= 3:
                break
        picked.reverse()
        return "\n".join(picked) if picked else "(empty session)"
    except Exception:  # noqa: BLE001 - a roster entry must never break the listing
        return ""


# ---------------------------------------------------------------- registry (disk)


def load_registry() -> dict[str, Any]:
    try:
        with open(REGISTRY_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_registry(reg: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(REGISTRY_FILE), exist_ok=True)
    tmp = REGISTRY_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, REGISTRY_FILE)


def register(name: str, node_ip: str, cwd: str, role: str) -> None:
    reg = load_registry()
    reg[name] = {
        "node_ip": node_ip,
        "cwd": cwd,
        "role": role,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    save_registry(reg)


def unregister(name: str) -> None:
    reg = load_registry()
    if reg.pop(name, None) is not None:
        save_registry(reg)


# ------------------------------------------------------- agent registry (node->url)
#
# node_ip -> {agent_url, last_seen, started_at, pid, sessions:[...]}. A client's kore-agent
# POSTs its own record to the server's register door, which writes one key per agent under
# a file lock; the engine is a pure reader. Discovery is push-based: a client heartbeats
# itself into the roster, so the server never has to pull a node list from anywhere.


def agents_load() -> dict[str, Any]:
    """Tolerant read, exactly like load_registry: a missing or half-written file is an
    empty registry, never an exception — a torn write during an agent's RMW must not
    take the roster down."""
    try:
        with open(KORE_AGENTS_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def agents_prune(agents: dict[str, Any] | None = None) -> dict[str, Any]:
    """Drop entries not seen within KORE_AGENT_TTL. Does NOT write — pruning is a read-time
    filter so a brief flap is survivable; only the owning agent ever removes its key."""
    agents = agents_load() if agents is None else agents
    now = time.time()
    return {
        ip: rec for ip, rec in agents.items()
        if isinstance(rec, dict) and now - float(rec.get("last_seen", 0) or 0) <= KORE_AGENT_TTL
    }


def resolve_agent_url(node_ip: str) -> str:
    """The agent URL for node_ip, or a clean refusal. Raises (never returns a bad URL) so
    a miss surfaces as a stated reason — koreops routes it through `_degraded_roster`, not a
    traceback — instead of a connection attempt against nothing."""
    validate_ip(node_ip)
    rec = agents_load().get(node_ip)
    if not isinstance(rec, dict) or not rec.get("agent_url"):
        raise RuntimeError(f"no kore-agent registered for node {node_ip} "
                           f"(unknown node — has a client joined from there?)")
    age = time.time() - float(rec.get("last_seen", 0) or 0)
    if age > KORE_AGENT_TTL:
        raise RuntimeError(f"kore-agent for node {node_ip} is stale "
                           f"(last heartbeat {int(age)}s ago, TTL {int(KORE_AGENT_TTL)}s)")
    return str(rec["agent_url"])


def agents_live() -> list[str]:
    """Every node_ip the engine can route to: the server's own node first, then every
    client with a fresh agent. The server is always a worker, so its node is always in
    the set even when no client has joined; the duplicate a same-host client would add is
    collapsed. This is the one list roster / job_map / alive_ips are built from."""
    ips = [_local_node_ip()] + [ip for ip in agents_prune() if IP_RE.match(ip)]
    return list(dict.fromkeys(ips))


_local_ip_cache: str = ""


def _local_node_ip() -> str:
    """This host's egress IP — the server's own node, which `sh()` routes locally.

    KORE_NODE_IP wins; else the UDP-connect trick (no packet is sent — connect() on a
    datagram socket just picks the egress interface); else loopback. Mirrors the agent's
    own detection so the node_ip the UI shows is the one writes validate against.
    Memoized: it is a property of the host, not of the moment, and `sh()` asks on every
    command."""
    global _local_ip_cache
    if _local_ip_cache:
        return _local_ip_cache
    if KORE_NODE_IP and IP_RE.match(KORE_NODE_IP):
        _local_ip_cache = KORE_NODE_IP
        return _local_ip_cache
    import socket  # noqa: PLC0415

    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            cand = s.getsockname()[0]
        finally:
            s.close()
        if IP_RE.match(cand):
            ip = cand
    except OSError:
        pass
    if ip == "127.0.0.1":
        try:
            cand = socket.gethostbyname(socket.gethostname())
            if IP_RE.match(cand):
                ip = cand
        except OSError:
            pass
    _local_ip_cache = ip
    return ip


# --------------------------------------------------------------- cluster node facts


def job_map(force: bool = False) -> dict[str, dict[str, Any]]:
    """node_ip -> node facts, one row per routable node (self + live clients).

    There is no scheduler to ask: a node is a bare host reachable either locally (self)
    or through its agent (a client). The columns kept for the UI's benefit (job_name /
    user / gpus / status) are therefore empty — index.html already tolerates blanks.
    `status` is "" on purpose: koreops.node_live treats an empty status as LIVE, so a node
    with a fresh agent is writable. `alive: True` satisfies node_live's first test;
    without it every node would read as dead.
    """
    import socket  # noqa: PLC0415

    out: dict[str, dict[str, Any]] = {}
    self_ip = _local_node_ip()
    reg = agents_load()
    for ip in agents_live():
        if not IP_RE.match(ip):
            continue
        is_self = ip == self_ip
        host = (socket.gethostname() if is_self
                else str((reg.get(ip) or {}).get("hostname") or ""))
        # `self` / `hostname` let the dashboard say WHICH machine a session lives on: the
        # server's own host, or a client (by its hostname). `agent_started` / `pid` come from
        # the client's register record (None for self) — the dashboard watches `agent_started`
        # change to confirm a "restart agent" actually bounced the process.
        rec = reg.get(ip) or {}
        out[ip] = {"job_name": "", "job_id": "", "user": "", "gpus": 0, "nnode": 0,
                   "status": "", "alive": True, "cpus": 0,
                   "self": is_self, "hostname": host,
                   "agent_started": rec.get("started_at"), "pid": rec.get("pid")}
    return out


def alive_ips() -> list[str]:
    """Nodes the engine may route to: self + every client with a fresh agent."""
    return agents_live()


# ---------------------------------------------------------------------- the verbs


def kore_cluster() -> dict[str, Any]:
    jm = job_map()
    nodes = [{"node_ip": ip, **facts} for ip, facts in sorted(jm.items())]
    return {"ok": True, "node_count": len(nodes), "nodes": nodes}


def kore_list(node_ip: str | None = None, with_summary: bool = True) -> dict[str, Any]:
    targets = [validate_ip(node_ip)] if node_ip else None
    if targets is None:
        reg = load_registry()
        targets = sorted({v["node_ip"] for v in reg.values()}) or alive_ips()

    jm = job_map()
    reg = load_registry()
    sessions: list[dict[str, Any]] = []
    unreachable: list[str] = []

    # One formatted list-sessions per node yields names AND the active-pane facts we surface on
    # the cards (window/pane counts, current command, live cwd, pane title) — same `-F` pattern
    # as list_unmanaged. Tab-separated; pane_title is last so a stray tab in it can't shift the
    # earlier fields. The active-pane context is what tmux evaluates `#{...}` against here.
    _LIST_FMT = ("#{session_name}\t#{session_windows}\t#{window_panes}\t"
                 "#{pane_current_command}\t#{pane_current_path}\t#{pane_title}")
    for ip in targets:
        try:
            r = sh(ip, f"tmux list-sessions -F '{_LIST_FMT}' 2>/dev/null | grep '^{TMUX_PREFIX}' || echo NONE", 20)
        except Exception as exc:  # noqa: BLE001 - one bad node must not hide the rest
            unreachable.append(ip)
            log(f"list: {ip} unreachable: {exc!r}")
            continue
        if "NONE" in r["stdout"]:
            continue
        facts = jm.get(ip, {})
        states = node_hook_states(ip)   # one round-trip; hook records for all this node's sessions
        for line in r["stdout"].strip().splitlines():
            parts = line.split("\t")
            name = parts[0].strip()
            if not name:
                continue
            windows = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            panes = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
            command = parts[3] if len(parts) > 3 else ""
            live_cwd = parts[4] if len(parts) > 4 else ""
            title = "\t".join(parts[5:]) if len(parts) > 5 else ""

            pane = ""
            try:
                pane = capture(ip, name, 40)
            except Exception:  # noqa: BLE001
                pass
            entry = {
                "name": name,
                "node_ip": ip,
                "job_name": facts.get("job_name", ""),
                "gpus": facts.get("gpus", 0),
                "role": (reg.get(name) or {}).get("role", ""),
                "cwd": (reg.get(name) or {}).get("cwd", ""),
                "state": session_state(ip, name, pane, states),
                # live tmux facts for the overview cards (active pane of the active window)
                "windows": windows,
                "panes": panes,
                "command": command,
                "live_cwd": live_cwd,
                "title": title,
            }
            # Surface the hook record's idle-stretch identity so the board can show a one-shot
            # "刚干完，去看看" indicator that clears once the user opens the session. `since`
            # marks when this idle/busy stretch began (stable across idle-prompt nudges).
            rec = states.get(name)
            if isinstance(rec, dict):
                if rec.get("since") is not None:
                    entry["state_since"] = rec["since"]
                if rec.get("detail"):
                    entry["state_detail"] = rec["detail"]
            if with_summary:
                entry["summary"] = summarize(ip, name)
            sessions.append(entry)

    result: dict[str, Any] = {"ok": True, "session_count": len(sessions), "sessions": sessions}
    if unreachable:
        result["unreachable_nodes"] = unreachable
    return result


def list_windows(node_ip: str, name: str) -> dict[str, Any]:
    """The tmux windows of one session (for the dashboard's window switcher). Read-only."""
    ip = validate_ip(node_ip)
    full = norm_name(name)
    fmt = "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}"
    r = sh(ip, f"tmux list-windows -t {full} -F '{fmt}' 2>/dev/null || echo NONE", 20)
    out = r["stdout"]
    wins: list[dict[str, Any]] = []
    if "NONE" not in out:
        for line in out.strip().splitlines():
            p = line.split("\t")
            if len(p) < 4 or not p[0].isdigit():
                continue
            wins.append({"index": int(p[0]), "name": p[1], "active": p[2] == "1",
                         "panes": int(p[3]) if p[3].isdigit() else 1})
    return {"ok": True, "node_ip": ip, "name": full, "windows": wins}


def list_panes(node_ip: str, name: str, window: int) -> dict[str, Any]:
    """The panes of one tmux window, with geometry, for the pane switcher AND the composite
    split view. Read-only. `window` is an int. Geometry is in cells, relative to the window;
    `win_cols`/`win_rows` let the dashboard lay the panes out proportionally."""
    ip = validate_ip(node_ip)
    full = norm_name(name)
    w = int(window)
    # command/title last-but-geometry: put the free-text title LAST so a stray tab can't shift
    # the numeric geometry fields.
    fmt = ("#{pane_index}\t#{pane_active}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t"
           "#{pane_height}\t#{window_width}\t#{window_height}\t#{pane_current_command}\t#{pane_title}")
    r = sh(ip, f"tmux list-panes -t {full}:{w:d} -F '{fmt}' 2>/dev/null || echo NONE", 20)
    out = r["stdout"]
    panes: list[dict[str, Any]] = []
    win_cols = win_rows = 0
    def _int(s: str) -> int:
        return int(s) if s.lstrip("-").isdigit() else 0
    if "NONE" not in out:
        for line in out.strip().splitlines():
            p = line.split("\t")
            if len(p) < 8 or not p[0].isdigit():
                continue
            win_cols, win_rows = _int(p[6]), _int(p[7])
            panes.append({"index": int(p[0]), "active": p[1] == "1",
                          "left": _int(p[2]), "top": _int(p[3]), "width": _int(p[4]), "height": _int(p[5]),
                          "command": p[8] if len(p) > 8 else "",
                          "title": "\t".join(p[9:]) if len(p) > 9 else ""})
    return {"ok": True, "node_ip": ip, "name": full, "window": w,
            "win_cols": win_cols, "win_rows": win_rows, "panes": panes}


_WIN_NAME_RE = re.compile(r"^[A-Za-z0-9_.\- ]{1,40}$")


def tmux_manage(node_ip: str, name: str, action: str, window: int | None = None,
                pane: int | None = None, title: str = "", direction: str = "h",
                cols: int | None = None, rows: int | None = None) -> dict[str, Any]:
    """Run ONE allowlisted tmux window/pane management command. Targets are built from the
    NAME-checked session plus integer window/pane (via %d), and a window name is char-checked
    and single-quoted — nothing caller-supplied reaches the shell unquoted or unchecked."""
    ip = validate_ip(node_ip)
    full = norm_name(name)
    wt = f"{full}:{int(window)}" if window is not None else full
    pt = f"{full}:{int(window)}.{int(pane)}" if (window is not None and pane is not None) else wt
    if action == "new-window":
        cmd = f"tmux new-window -t {full}"
        if title:
            if not _WIN_NAME_RE.match(title):
                return {"ok": False, "error": f"bad window name {title!r}"}
            cmd += f" -n '{title}'"
    elif action == "kill-window":
        cmd = f"tmux kill-window -t {wt}"
    elif action == "rename-window":
        if not _WIN_NAME_RE.match(title):
            return {"ok": False, "error": f"bad window name {title!r}"}
        cmd = f"tmux rename-window -t {wt} '{title}'"
    elif action == "split-window":
        flag = "-v" if direction == "v" else "-h"
        cmd = f"tmux split-window {flag} -t {pt}"
    elif action == "kill-pane":
        cmd = f"tmux kill-pane -t {pt}"
    elif action == "resize-pane":
        parts = []
        if cols is not None:
            parts.append(f"-x {int(cols):d}")
        if rows is not None:
            parts.append(f"-y {int(rows):d}")
        if not parts:
            return {"ok": False, "error": "resize-pane needs cols and/or rows"}
        cmd = f"tmux resize-pane -t {pt} {' '.join(parts)}"
    else:
        return {"ok": False, "error": f"bad action {action!r}"}
    r = sh(ip, cmd + " 2>&1", 20)
    rc = int(r.get("rc") or 0)
    return {"ok": rc == 0, "action": action,
            "error": "" if rc == 0 else (r.get("stdout") or "").strip()[:200]}


def kore_start(node_ip: str, name: str, cwd: str = "~", role: str = "", claude_path: str = "") -> dict[str, Any]:
    validate_ip(node_ip)
    name = norm_name(name)
    with session_lock(node_ip, name):
        if has_session(node_ip, name):
            return {"ok": False, "error": f"session {name!r} already exists on {node_ip}", "name": name}

        target = cwd if cwd == "~" or cwd.startswith("/") else f"~/{cwd}"
        claude = claude_path or "claude"
        # IS_SANDBOX=1 is what lets Claude Code run as root with --dangerously-skip-permissions;
        # worker nodes are expected to be isolated containers.
        # cwd and claude_path come from a caller (an LLM over MCP, or the workbench)
        # and both land in a remote shell, so quote them instead of interpolating:
        # a cwd of `/tmp'; rm -rf /x #` used to break straight out of send-keys' quotes.
        inner = (f"cd {quote_path(target)} && IS_SANDBOX=1 {shlex.quote(claude)} "
                 f"--dangerously-skip-permissions")
        # Only TYPE the launch command into the pane — do NOT press Enter, and do nothing
        # else afterwards (no trust-folder auto-confirm, no readiness polling). The human runs
        # it from the terminal when ready. (`echo OK` runs in the node's outer shell, not the
        # pane, so it just confirms new-session + send-keys succeeded.)
        cmd = (
            f"tmux new-session -d -s {name} -c {quote_path(target)} && "
            f"tmux send-keys -t {name} {shlex.quote(inner)} && echo OK"
        )
        r = sh(node_ip, cmd, 30)
        if "OK" not in r["stdout"]:
            return {"ok": False, "error": (r["stderr"] or r["stdout"] or "tmux new-session failed").strip()}

        register(name, node_ip, cwd, role)
        return {"ok": True, "name": name, "node_ip": node_ip, "cwd": cwd, "role": role,
                "state": "created",
                "note": "启动命令已输入 tmux 会话但未回车；在终端里按 Enter 即可启动 Claude Code"}


def kore_send(node_ip: str, name: str, message: str, wait: bool = True, timeout: int = 600) -> dict[str, Any]:
    validate_ip(node_ip)
    name = norm_name(name)
    with session_lock(node_ip, name):
        if not has_session(node_ip, name):
            return {"ok": False, "error": f"session {name!r} not found on {node_ip}"}

        if message:
            send_keys(node_ip, name, literal=message)
            time.sleep(0.3)
        send_keys(node_ip, name, key="Enter")
        mark_busy(node_ip, name)   # optimistic: the turn is starting (UserPromptSubmit confirms)

        if not wait:
            time.sleep(3)
            return {"ok": True, "name": name, "state": "sent", "output": clean(capture(node_ip, name, 120))}

        deadline = time.time() + timeout
        idle_streak = 0
        last = ""
        time.sleep(2)  # let Claude Code register the input before the first busy check
        while time.time() < deadline:
            pane = capture(node_ip, name, 200)
            last = pane
            st = session_state(node_ip, name, pane)
            if st == "busy":
                idle_streak = 0
            elif st == "waiting":
                # Claude stopped on a permission / choice prompt: nothing settles until
                # someone answers, so hand back now instead of burning the timeout.
                return {"ok": True, "name": name, "state": "waiting", "output": clean(pane)}
            else:
                idle_streak += 1
                # Two consecutive idle reads: Claude Code pauses between tool calls, so a
                # single quiet sample is not settlement.
                if idle_streak >= 2:
                    return {"ok": True, "name": name, "state": "idle", "output": clean(pane)}
            time.sleep(2)

        return {"ok": True, "name": name, "state": "timeout",
                "note": f"still busy after {timeout}s; output is partial and work continues",
                "output": clean(last)}


def kore_read(node_ip: str, name: str, lines: int = 120) -> dict[str, Any]:
    validate_ip(node_ip)
    name = norm_name(name)
    if not has_session(node_ip, name):
        return {"ok": False, "error": f"session {name!r} not found on {node_ip}"}
    pane = capture(node_ip, name, lines)
    return {"ok": True, "name": name, "state": session_state(node_ip, name, pane),
            "output": clean(pane)}


def kore_keys(node_ip: str, name: str, key: str) -> dict[str, Any]:
    validate_ip(node_ip)
    name = norm_name(name)
    with session_lock(node_ip, name):
        if not has_session(node_ip, name):
            return {"ok": False, "error": f"session {name!r} not found on {node_ip}"}
        send_keys(node_ip, name, key=key)
        time.sleep(1.5)
        return {"ok": True, "name": name, "sent_key": key, "output": clean(capture(node_ip, name, 60))}


def kore_status(node_ip: str, name: str) -> dict[str, Any]:
    validate_ip(node_ip)
    name = norm_name(name)
    if not has_session(node_ip, name):
        return {"ok": True, "name": name, "tmux": False, "claude": False, "state": "dead"}
    r = sh(
        node_ip,
        f"tmux list-panes -t {name} -F '#{{pane_pid}}' | head -1 | "
        f"xargs -I{{}} sh -c 'pgrep -P {{}} -a 2>/dev/null | grep -q claude && echo ALIVE || echo GONE'",
        25,
    )
    claude_alive = "ALIVE" in r["stdout"]
    pane = capture(node_ip, name, 40)
    state = session_state(node_ip, name, pane) if claude_alive else "tmux_only"
    return {"ok": True, "name": name, "tmux": True, "claude": claude_alive,
            "state": state, "summary": summarize(node_ip, name)}


def list_unmanaged(node_ip: str) -> list[dict[str, Any]]:
    """tmux sessions on node_ip that do NOT carry the prefix — candidates for kore_adopt.

    `adoptable` is false (with `why`) when the name cannot be adopted as-is: characters a
    session name may not have, a prefixed name that would be too long for the write door
    (48), or a `<prefix><name>` session that already exists."""
    validate_ip(node_ip)
    r = sh(node_ip, "tmux list-sessions -F "
                    "'#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_path}'"
                    " 2>/dev/null || true", 20)
    rows = [ln.split("\t") for ln in r["stdout"].splitlines() if ln.strip()]
    names = {row[0] for row in rows}
    out: list[dict[str, Any]] = []
    for row in rows:
        name = row[0]
        if name.startswith(TMUX_PREFIX):
            continue
        full = TMUX_PREFIX + name
        why = ""
        if not SESSION_NAME_RE.match(name):
            why = "名字只能含字母、数字、- 和 _"
        elif len(full) > 48:
            why = f"加上前缀后超过 48 个字符（{full}）"
        elif full in names:
            why = f"已经有一个叫 {full} 的 session"
        out.append({"name": name, "full_name": full,
                    "windows": int(row[1]) if len(row) > 1 and row[1].isdigit() else 0,
                    "attached": len(row) > 2 and row[2] not in ("", "0"),
                    "cwd": row[3] if len(row) > 3 else "",
                    "adoptable": not why, "why": why})
    return out


def kore_adopt(node_ip: str, name: str) -> dict[str, Any]:
    """Bring an existing tmux session under kore by renaming it into the prefix
    (`work` -> `kore-work`). Nothing inside the session is touched: the programs keep
    running and attached clients stay attached. `-t =name` matches the name exactly, so a
    session called `work` can never be confused with `work2`."""
    validate_ip(node_ip)
    if not SESSION_NAME_RE.match(name or "") or name.startswith(TMUX_PREFIX):
        return {"ok": False, "error": f"cannot adopt {name!r}: needs an unprefixed name "
                                      f"of letters, digits, - and _"}
    full = TMUX_PREFIX + name
    with session_lock(node_ip, full):
        r = sh(node_ip,
               f"if ! tmux has-session -t ={name} 2>/dev/null; then echo NOSUCH; "
               f"elif tmux has-session -t ={full} 2>/dev/null; then echo EXISTS; "
               f"else tmux rename-session -t ={name} {full} && echo OK; fi", 20)
    out = r["stdout"]
    if "OK" in out:
        return {"ok": True, "name": full, "from": name, "action": "adopted"}
    if "NOSUCH" in out:
        return {"ok": False, "error": f"no tmux session named {name!r} on {node_ip}"}
    if "EXISTS" in out:
        return {"ok": False, "error": f"a session named {full!r} already exists on {node_ip}"}
    return {"ok": False, "error": (r["stderr"] or out or "tmux rename-session failed").strip()}


def kore_stop(node_ip: str, name: str) -> dict[str, Any]:
    validate_ip(node_ip)
    name = norm_name(name)
    with session_lock(node_ip, name):
        r = sh(node_ip, f"tmux kill-session -t {name} 2>&1 && echo OK || echo FAIL", 20)
        if "OK" in r["stdout"]:
            unregister(name)
            return {"ok": True, "name": name, "action": "stopped"}
        return {"ok": False, "error": (r["stdout"] or "kill-session failed").strip()}


def node_run(node_ip: str, command: str, timeout: int = 120) -> dict[str, Any]:
    validate_ip(node_ip)
    r = sh(node_ip, command, timeout)
    return {"ok": r["rc"] == 0, "exit_code": r["rc"],
            "stdout": clean(r["stdout"]), "stderr": clean(r["stderr"])}


def node_read(node_ip: str, path: str, tail: int = 0) -> dict[str, Any]:
    validate_ip(node_ip)
    quoted = "'" + path.replace("'", "'\\''") + "'"
    cmd = f"tail -n {int(tail)} {quoted}" if tail else f"cat {quoted}"
    r = sh(node_ip, cmd, 60)
    if r["rc"] != 0:
        return {"ok": False, "error": clean(r["stderr"]) or f"could not read {path}"}
    return {"ok": True, "path": path, "content": clean(r["stdout"])}


# ------------------------------------------------------------------- MCP surface

TOOLS: list[dict[str, Any]] = [
    {
        "name": "kore_cluster",
        "description": (
            "List every node the engine can reach — the server's own host plus any clients that have "
            "joined — by IP. Call this first to learn which nodes exist before placing or addressing "
            "any kore session. Fast (~1-3s)."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "kore_list",
        "description": (
            "List kore sessions (Claude Code teammates) with node, job name, role, busy/waiting/idle state and a "
            "short summary of what each is doing. This is the roster view: call it to see the whole team "
            "at once. Omit node_ip to scan registered nodes, or all alive nodes when none are registered."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string", "description": "Restrict to one node IP."},
                "with_summary": {
                    "type": "boolean",
                    "description": "Include a 3-line activity summary per session. Default true.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "kore_start",
        "description": (
            "Start a new Claude Code teammate: a tmux session running the interactive Claude Code CLI on one "
            "worker node. Use one session per role (data production, training, evaluation) and set "
            "'role' so the roster explains itself. Takes ~10-25s while Claude Code boots. Fails if the name exists."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string", "description": "Worker node IP from kore_cluster."},
                "name": {"type": "string", "description": "Session name; the session prefix (default 'kore-') is added if absent."},
                "cwd": {"type": "string", "description": "Working directory on that node. Default '~'."},
                "role": {
                    "type": "string",
                    "description": "What this teammate owns, e.g. 'data-production', 'training', 'eval'.",
                },
                "claude_path": {"type": "string", "description": "Absolute path to the claude binary if not on PATH."},
            },
            "required": ["node_ip", "name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "kore_send",
        "description": (
            "Give one instruction to a kore teammate and, by default, wait until it goes idle before "
            "returning its screen. This is how real work is delegated. State the deliverable and where to "
            "write it; the session keeps its own history, so later instructions may reference earlier turns. "
            "A 'timeout' state means the work continues — poll later with kore_read instead of resending."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string"},
                "session_name": {"type": "string"},
                "message": {"type": "string", "description": "The instruction to type into Claude Code."},
                "wait": {"type": "boolean", "description": "Wait until Claude Code is idle. Default true."},
                "timeout_seconds": {"type": "integer", "description": "Max wait. Default 600."},
            },
            "required": ["node_ip", "session_name", "message"],
            "additionalProperties": False,
        },
    },
    {
        "name": "kore_read",
        "description": (
            "Read a kore teammate's current screen without sending anything. Use to check on long-running "
            "work after a kore_send returned 'timeout'."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string"},
                "session_name": {"type": "string"},
                "lines": {"type": "integer", "description": "Pane lines to capture. Default 120."},
            },
            "required": ["node_ip", "session_name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "kore_keys",
        "description": (
            "Send one raw key to a kore teammate for menus and interrupts: Enter, Escape, Up, Down, Y, N, C-c. "
            "Escape interrupts Claude Code's current work; C-c would kill the process, so prefer Escape."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string"},
                "session_name": {"type": "string"},
                "key": {"type": "string", "description": "tmux key token, e.g. Enter / Escape / Up / Y."},
            },
            "required": ["node_ip", "session_name", "key"],
            "additionalProperties": False,
        },
    },
    {
        "name": "kore_status",
        "description": (
            "Health-check one kore teammate: tmux alive, the claude process alive, busy/waiting/idle (waiting = blocked on a permission/choice prompt), plus an "
            "activity summary. 'tmux_only' means Claude Code crashed and the session needs restarting."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"node_ip": {"type": "string"}, "session_name": {"type": "string"}},
            "required": ["node_ip", "session_name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "kore_stop",
        "description": "Kill a kore teammate's tmux session and drop it from the roster. Unsaved Claude Code state is lost.",
        "inputSchema": {
            "type": "object",
            "properties": {"node_ip": {"type": "string"}, "session_name": {"type": "string"}},
            "required": ["node_ip", "session_name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "node_run",
        "description": (
            "Run one shell command on a node and return stdout/stderr/exit code. Prefer this over asking a "
            "kore teammate to describe state: a command's output is evidence, a session's summary is a claim. "
            "Use for checking artifacts, nvidia-smi, tailing logs."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string"},
                "command": {"type": "string"},
                "timeout_seconds": {"type": "integer", "description": "Default 120."},
            },
            "required": ["node_ip", "command"],
            "additionalProperties": False,
        },
    },
    {
        "name": "node_read",
        "description": "Read a file from a node — configs, metrics, logs, produced artifacts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "node_ip": {"type": "string"},
                "path": {"type": "string", "description": "Absolute path on that node."},
                "tail": {"type": "integer", "description": "Only the last N lines; 0 reads the whole file."},
            },
            "required": ["node_ip", "path"],
            "additionalProperties": False,
        },
    },
]


def call_tool(name: str, a: dict[str, Any]) -> dict[str, Any]:
    if name == "kore_cluster":
        return kore_cluster()
    if name == "kore_list":
        return kore_list(a.get("node_ip") or None, bool(a.get("with_summary", True)))
    if name == "kore_start":
        return kore_start(
            str(a["node_ip"]), str(a["name"]),
            str(a.get("cwd") or "~"), str(a.get("role") or ""), str(a.get("claude_path") or ""),
        )
    if name == "kore_send":
        return kore_send(
            str(a["node_ip"]), str(a["session_name"]), str(a["message"]),
            bool(a.get("wait", True)), int(a.get("timeout_seconds") or 600),
        )
    if name == "kore_read":
        return kore_read(str(a["node_ip"]), str(a["session_name"]), int(a.get("lines") or 120))
    if name == "kore_keys":
        return kore_keys(str(a["node_ip"]), str(a["session_name"]), str(a["key"]))
    if name == "kore_status":
        return kore_status(str(a["node_ip"]), str(a["session_name"]))
    if name == "kore_stop":
        return kore_stop(str(a["node_ip"]), str(a["session_name"]))
    if name == "node_run":
        return node_run(str(a["node_ip"]), str(a["command"]), int(a.get("timeout_seconds") or 120))
    if name == "node_read":
        return node_read(str(a["node_ip"]), str(a["path"]), int(a.get("tail") or 0))
    return {"ok": False, "error": f"unknown tool {name!r}"}


def send(obj: dict[str, Any]) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def handle(msg: dict[str, Any]) -> None:
    method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}

    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }})
        return
    if method in ("notifications/initialized", "initialized"):
        return
    if method == "ping":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
        return
    if method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        return
    if method == "tools/call":
        tool = str(params.get("name"))
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32602, "message": "arguments must be an object"}})
            return
        log(f"call {tool} {json.dumps(args, ensure_ascii=False)[:200]}")
        t0 = time.time()
        try:
            result = call_tool(tool, args)
        except KeyError as exc:
            result = {"ok": False, "error": f"missing required argument: {exc}"}
        except Exception as exc:  # noqa: BLE001 - a tool fault must not kill the server
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        result.setdefault("elapsed_seconds", round(time.time() - t0, 1))
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
            "isError": not result.get("ok", False),
        }})
        return
    if rid is not None:
        send({"jsonrpc": "2.0", "id": rid,
              "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> None:
    if not KORE_AGENT_TOKEN:
        log("WARNING: KORE_AGENT_TOKEN is empty — a client agent's /exec is unauthenticated "
            "RCE; set it (same value on the server and every client) before any cross-node use")
    log(f"ready (self node={_local_node_ip()} agents={KORE_AGENTS_FILE} "
        f"ttl={int(KORE_AGENT_TTL)}s prefix={TMUX_PREFIX} registry={REGISTRY_FILE})")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"ignoring non-JSON input: {line[:120]}")
            continue
        try:
            handle(msg)
        except Exception as exc:  # noqa: BLE001 - keep serving after any fault
            log(f"handler error: {exc!r}")
            if msg.get("id") is not None:
                send({"jsonrpc": "2.0", "id": msg["id"],
                      "error": {"code": -32603, "message": f"internal error: {exc}"}})


if __name__ == "__main__":
    main()
