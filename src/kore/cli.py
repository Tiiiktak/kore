"""kore CLI — one command over the self-contained entry scripts.

    kore            (no args) same as `kore server` — the one-command start
    kore server     start kore as the central node: launch the dashboard in the
                    background, print a ready-to-click tokened link, AND print a
                    one-line join command to add more machines. The server is also a
                    worker, so a single machine needs nothing but `kore server`.
                    (`kore server --restart` applies new config to a running board)
    kore client     join THIS machine to a server as a worker node. Requires
                    `--server <ip:port>` and `--token <tok>` (from the server's join
                    line) — there is no default.
    kore adopt      bring existing tmux sessions on THIS machine under kore: with no
                    names, list the ones without the prefix; `kore adopt work` renames
                    `work` -> `kore-work` (the programs inside keep running)
    kore down       stop the background dashboard started by `kore server`
    kore status     is the background dashboard up? reprint its link
    kore upgrade    update kore in place to the latest release (`--version vX.Y.Z` to
                    pin, `--check` to only compare); knows clone vs `uv tool` installs
    kore mcp        run the MCP-over-stdio server (kore-bridge.py)
    kore ops …      the write-door / engine CLI (koreops.py: roster, policy, …)
    kore doctor     preflight the environment and print a PASS/WARN/FAIL table

Design notes (why it is built this way):
  * The entry scripts are shipped as package *data* and run by path with
    `runpy.run_path(..., run_name="__main__")` — same process, correct `__file__`,
    env preserved. koreops' subprocess self-relaunch (`python <abspath koreops.py> …`)
    is untouched, and the hyphenated / extension-less files never need to be import-
    able modules.
  * Writable state is steered into `~/.kore/` with setdefault() BEFORE any
    dispatch, so an installed wheel (whose package dir is read-only) never tries to
    write a token or an audit log next to the code. An explicit env value always wins.
  * The cross-command "cluster identity" vars are top-level flags; they set the
    matching env before the subcommand inherits it, so the server/client/mcp paths
    cannot silently disagree on prefix or token. Put them BEFORE the subcommand:
        kore --agent-token "$TOK" server
"""

from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import secrets
import shutil
import socket
import subprocess
import sys
import time

PKG = os.path.dirname(os.path.abspath(__file__))

# Installed version, for `kore --version` and the upgrade up-to-date check.
try:
    from kore import __version__ as _VERSION
except Exception:        # running in some odd layout; version is non-critical here
    _VERSION = "?"

# The GitHub repo `kore upgrade` pulls from. Overridable so a fork can self-update.
REPO = os.environ.get("KORE_REPO", "Tiiiktak/kore")
# The one-line installer (`curl -fsSL <this> | sh`). `kore upgrade` re-runs it for an
# install that came from it.
INSTALL_URL = os.environ.get(
    "KORE_INSTALL_URL", f"https://raw.githubusercontent.com/{REPO}/main/install.sh")

# _apply_env_defaults() strips these (intranet agents must not traverse a proxy), but
# reaching GitHub for an upgrade usually MUST. Snapshot the user's real values at import
# time — before anything strips them — and restore them only for upgrade's own network
# calls (see _net_env). Never leaks into the dashboard/agent/engine env.
_PROXY_VARS = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
               "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY")
_ORIG_PROXY = {v: os.environ[v] for v in _PROXY_VARS if v in os.environ}

# State lands under ~/.kore. KORE_STATE_HOME overrides the location.
STATE_HOME = os.path.expanduser(
    os.environ.get("KORE_STATE_HOME") or "~/.kore")
# Where `kore server` records the background dashboard so `down`/`status` can find it.
# Per-host file names: ~/.kore often lives on shared storage (an NFS/GPFS home seen by
# every machine), so a pid recorded on one host must never be signalled from another.
HOST = (socket.gethostname() or "host").split(".")[0]
PIDFILE = os.path.join(STATE_HOME, f"server-{HOST}.pid")
RUNFILE = os.path.join(STATE_HOME, f"server-{HOST}.run")   # live board config, "k=v"
LOGFILE = os.path.join(STATE_HOME, f"server-{HOST}.log")
LEGACY_PIDFILE = os.path.join(STATE_HOME, "kore.pid")      # written by kore <= 0.3.5
# `kore client` runs the agent in the background too.
CLIENT_PIDFILE = os.path.join(STATE_HOME, f"client-{HOST}.pid")
CLIENT_RUNFILE = os.path.join(STATE_HOME, f"client-{HOST}.run")
CLIENT_LOGFILE = os.path.join(STATE_HOME, f"client-{HOST}.log")
CLIENT_STATUS = os.path.join(STATE_HOME, f"client-{HOST}.status")   # written by the agent
# The agent (client-join) token: minted on first `kore server`, 0600, like the WB token.
AGENT_TOKEN_FILE = os.path.join(STATE_HOME, "agent.token")

# The two packaged scripts spawned/relaunched by subcommand.
SERVER_PY = "workbench/server.py"   # the dashboard, background-launched by `kore server`
AGENT_PY = "kore-agent.py"          # the per-node agent, run by `kore client`
_SCRIPTS = {
    "mcp": "kore-bridge.py",
    "ops": "koreops.py",
}

# top-level flag -> the env suffix it sets (the cross-command "cluster identity")
_IDENTITY = [
    ("--agents-file", "AGENTS_FILE", "agent registry path (node_ip -> url)"),
    ("--agent-token", "AGENT_TOKEN", "server<->client agent shared secret (the /exec fence "
                                     "and the client-join token)"),
    ("--prefix", "BRIDGE_PREFIX", "tmux session name prefix (default kore-)"),
    ("--node-ip", "NODE_IP", "override this node's advertised IP"),
]


def _env(suffix: str, default: str = "") -> str:
    """Read an identity var by suffix: KORE_<suffix>, else default."""
    return os.environ.get("KORE_" + suffix, default)


def _set_env(suffix: str, value: str) -> None:
    os.environ["KORE_" + suffix] = value


def _setdefault_env(suffix: str, value: str) -> None:
    if "KORE_" + suffix not in os.environ:
        _set_env(suffix, value)


def _apply_env_defaults() -> None:
    """Steer writable state under ~/.kore, proxy hygiene.

    setdefault-style throughout: an explicit env value always wins."""
    os.environ.setdefault("RSI_CCOPS_STATE", os.path.join(STATE_HOME, "ccops"))
    os.environ.setdefault("WB_TOKEN_FILE", os.path.join(STATE_HOME, "wb.token"))
    # The entry scripts default these under ~/.kore too, but set them explicitly so every
    # consumer (dashboard, agent, engine, koreops self-relaunch) agrees on one place (and
    # an explicit env value still wins over this).
    _setdefault_env("AGENTS_FILE", os.path.join(STATE_HOME, "agents.json"))
    _setdefault_env("REGISTRY", os.path.join(STATE_HOME, "sessions.json"))
    _setdefault_env("BRIDGE_PREFIX", "kore-")      # the brand prefix
    # Intranet agents usually must NOT traverse an HTTP proxy (mirrors service.sh).
    for v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        os.environ.pop(v, None)
    os.environ.setdefault("NO_PROXY", "10.0.0.0/8,127.0.0.1,localhost")
    os.environ.setdefault("no_proxy", os.environ["NO_PROXY"])


def _run(rel: str, argv: list) -> int:
    """Run a packaged entry script as if it were `python <script> <argv>`."""
    path = os.path.join(PKG, rel)
    sys.argv = [path, *argv]
    runpy.run_path(path, run_name="__main__")
    return 0


# --------------------------------------------------------------------- tokens

def _load_agent_token() -> str:
    """Read ~/.kore/agent.token, minting it (0600, owner only) on first start.

    The server<->client shared secret: a client joins by presenting it, and the engine
    presents it to a client agent's /exec. Same discipline as the WB token (server.py
    `load_token`): one file, created once, never world-readable."""
    try:
        with open(AGENT_TOKEN_FILE, encoding="utf-8") as f:
            tok = f.read().strip()
        if tok:
            return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(32)
    os.makedirs(STATE_HOME, exist_ok=True)
    fd = os.open(AGENT_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(tok + "\n")
    return tok


# ----------------------------------------------------------------- server / client

def _pid_alive(pid: int, marker: str) -> bool:
    """Is `pid` a live process on THIS host running `marker` (a script path fragment)?
    Checking the command line guards against pid reuse and against a pidfile written on
    another host that shares this home directory."""
    try:
        os.kill(pid, 0)           # signal 0 = "does this process exist"
    except ProcessLookupError:
        return False
    except PermissionError:
        pass                      # exists but owned by someone else
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return marker.encode() in f.read()
    except OSError:
        return True               # no /proc (macOS): trust the signal-0 answer


def _pidfile_read(path: str, marker: str) -> int:
    """The pid recorded in `path` ("<pid> <host>"), or 0 if it is not a live `marker`
    process on this host."""
    try:
        with open(path, encoding="utf-8") as f:
            parts = f.read().split()
        pid = int(parts[0])
    except (OSError, ValueError, IndexError):
        return 0
    if len(parts) > 1 and parts[1] != HOST:
        return 0                  # recorded on another machine sharing this home
    return pid if _pid_alive(pid, marker) else 0


def _pidfile_write(path: str, pid: int) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"{pid} {HOST}\n")


def _read_pid() -> int:
    """The pid of the background board on THIS host, or 0."""
    return (_pidfile_read(PIDFILE, "workbench/server.py")
            or _pidfile_read(LEGACY_PIDFILE, "workbench/server.py"))


def _read_client_pid() -> int:
    """The pid of the background client agent on THIS host, or 0."""
    return _pidfile_read(CLIENT_PIDFILE, "kore-agent.py")

def _health_ok(host: str, port: str, timeout: float = 1.0) -> bool:
    """Is the board answering /api/health? (the one endpoint that needs no token)."""
    import urllib.request  # noqa: PLC0415
    probe = "127.0.0.1" if host in ("0.0.0.0", "") else host
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed scheme, loopback host
                f"http://{probe}:{port}/api/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _link(port: str) -> tuple[str, str]:
    """The ready-to-click dashboard URL (token in the query) + a localhost alternative.

    `?token=` is the read-auth the dashboard already accepts on GET (see server.py):
    opening this URL authenticates the browser in one click — no copy-paste, no 401.
    The token is written by the server on first start; we read it back here."""
    tok = ""
    try:
        with open(os.environ["WB_TOKEN_FILE"], encoding="utf-8") as f:
            tok = f.read().strip()
    except OSError:
        pass
    q = f"/?token={tok}" if tok else "/"
    ip = _detect_node_ip()
    primary = f"http://{ip}:{port}{q}"
    local = f"http://127.0.0.1:{port}{q}"
    return primary, local


def _join_cmd(port: str, tok: str) -> str:
    """The one-line command a second machine pastes to join as a worker (k3s/tailscale
    style): it names this server's reachable address and the agent token."""
    ip = _detect_node_ip()
    return f"kore client --server {ip}:{port} --token {tok}"


def _runfile_write(host: str, port: str, prefix: str) -> None:
    with open(RUNFILE, "w", encoding="utf-8") as f:
        f.write(f"host={host}\nport={port}\nprefix={prefix}\n")


def _runfile_read() -> dict:
    """Parse the live board config (`k=v` per line); {} if there is no run file."""
    cfg: dict = {}
    try:
        with open(RUNFILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line:
                    k, v = line.split("=", 1)
                    cfg[k] = v
    except OSError:
        pass
    return cfg


def _server_banner(pid: int, port: str, prefix: str, tok: str, *, already: bool) -> None:
    primary, local = _link(port)
    lead = (f"kore server is already running (pid {pid}, prefix={prefix})."
            if already else
            f"kore server is up  —  pid {pid}, prefix={prefix}")
    sys.stdout.write(
        f"\n{lead}\n\n"
        f"  👉  open the dashboard (token included — one click, no login):\n\n"
        f"      {primary}\n      {local}\n\n"
        f"  add another machine — run this on it (needs network both ways):\n\n"
        f"      {_join_cmd(port, tok)}\n\n"
        f"      (kore not installed there yet?  curl -fsSL {INSTALL_URL} | sh)\n\n"
        f"  logs:  {LOGFILE}\n  stop:  kore down\n\n")
    if shutil.which("tmux"):
        tv, ver = _tmux_version()
        if ver is not None and ver < TMUX_RECOMMENDED:
            sys.stdout.write(
                f"  ⚠  {tv} is older than {'.'.join(map(str, TMUX_RECOMMENDED))}: kore works, "
                f"but {_tmux_degraded(ver)}.\n     Run `kore doctor` for how to upgrade "
                f"tmux on this machine.\n\n")


def _server(rest: list) -> int:
    """Start kore as the SERVER (central node): background dashboard + engine, and this
    host is also a worker. Mint/load the agent token, print the dashboard link and the
    one-line join command a client pastes to add its node.

    `--restart`/`--force` tears down a running board and brings it back with the current
    config. Without it, if you pass config that disagrees with what is already running, we
    WARN loudly (and tell you how to apply it) instead of silently ignoring the flags.
    """
    restart = any(a in ("--restart", "--force", "-r") for a in rest)
    rest = [a for a in rest if a not in ("--restart", "--force", "-r")]

    # Agent token: a flag/env value wins, else mint one (0600) like the WB token. Set it
    # into the environment so the server, engine and resident children share one secret,
    # and so the client-register door is enabled.
    tok = _env("AGENT_TOKEN") or _load_agent_token()
    _set_env("AGENT_TOKEN", tok)

    # The dashboard port carries writes; binding 0.0.0.0 is acceptable ONLY because
    # server.py enforces token auth on every endpoint but /api/health. Override with
    # WB_HOST=127.0.0.1 to bind loopback + tunnel.
    os.environ.setdefault("WB_HOST", "0.0.0.0")
    os.environ.setdefault("WB_PORT", "8198")
    host, port = os.environ["WB_HOST"], os.environ["WB_PORT"]
    prefix = _env("BRIDGE_PREFIX")

    pid = _read_pid()
    if pid and _health_ok(host, port):
        if restart:
            sys.stdout.write("kore is running; --restart requested, bringing it down "
                             "first...\n")
            _stop_pid(pid)                 # the board only — a client here keeps running
            _rm(PIDFILE, RUNFILE, LEGACY_PIDFILE)
        else:
            prev = _runfile_read()
            desired = {"host": host, "port": port, "prefix": prefix}
            drift = [(k, prev.get(k, "?"), v) for k, v in desired.items()
                     if k in prev and prev[k] != v]
            if drift:
                primary, local = _link(port)
                sys.stdout.write(
                    f"\n⚠  kore is already running (pid {pid}) — the config you passed is "
                    f"NOT applied to a live board:\n")
                for k, old, new in drift:
                    sys.stdout.write(f"       {k}: running={old}  requested={new}\n")
                sys.stdout.write(
                    "\n    To apply it, restart the board:\n"
                    "       kore server --restart    (or:  kore down && kore server)\n\n"
                    f"    Current board:\n      👉  {primary}\n      {local}\n\n")
                return 0
            _server_banner(pid, port, prefix, tok, already=True)
            return 0

    os.makedirs(STATE_HOME, exist_ok=True)
    # Detach: new session (survives this shell), stdin off, logs to a file. We spawn the
    # server script directly with the SAME interpreter and the env we just arranged, so
    # this works identically from a clone, `uvx`, and `uv tool install`.
    log = open(LOGFILE, "a", encoding="utf-8")
    log.write(f"\n===== kore server {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
    log.flush()
    proc = subprocess.Popen(
        [sys.executable, os.path.join(PKG, SERVER_PY)],
        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
        start_new_session=True, env=os.environ.copy())
    _pidfile_write(PIDFILE, proc.pid)
    _runfile_write(host, port, prefix)

    # Register Claude Code status hooks for THIS (self) node. It runs claude sessions but has
    # no kore-agent of its own to self-install them (client nodes do that on agent startup).
    # Best-effort and idempotent (opt out with KORE_NO_HOOKS=1); must not block startup.
    try:
        subprocess.run([sys.executable, os.path.join(PKG, AGENT_PY), "install-hooks"],
                       env=os.environ.copy(), timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:  # noqa: BLE001
        pass

    # Wait for the board to answer, so the link we print actually opens.
    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.stderr.write(
                f"\nkore failed to start (exited {proc.returncode}). Last log lines:\n")
            _tail(LOGFILE, 15)
            return 1
        if _health_ok(host, port):
            break
        time.sleep(0.25)
    else:
        sys.stderr.write(f"\nkore started (pid {proc.pid}) but did not answer within 15s; "
                         f"check {LOGFILE}\n")
        return 1

    _server_banner(proc.pid, port, prefix, tok, already=False)
    return 0


def _client(rest: list) -> int:
    """Join THIS machine to a server as a worker node, in the background.

    Requires the server's address and the agent token it printed — there is NO default
    for either. Checks the server is reachable, starts the agent detached, and waits for
    the first registration to come back before returning, so a wrong token or a blocked
    port is reported here instead of discovered later as "the node never showed up".
    `--foreground` runs the agent attached to this terminal (for systemd / debugging).
    """
    ap = argparse.ArgumentParser(
        prog="kore client",
        description="Join this machine to a kore server as a worker node (paste the join "
                    "command the server printed). Runs in the background; stop with "
                    "`kore down`.")
    ap.add_argument("--server", required=True, metavar="IP:PORT",
                    help="the server's dashboard address, e.g. 10.0.0.7:8198 (no default)")
    ap.add_argument("--token", required=True, metavar="TOK",
                    help="the agent token from the server's join command (no default)")
    ap.add_argument("--foreground", action="store_true",
                    help="run the agent in this terminal instead of the background")
    # argparse exits 2 with a usage error if --server/--token are missing — "no default".
    args, passthrough = ap.parse_known_args(rest)

    server = args.server.strip()
    if "://" in server:
        server = server.split("://", 1)[1]
    server = server.rstrip("/")
    if not server or ":" not in server:
        sys.stderr.write("kore client: --server must be <ip:port> (e.g. 10.0.0.7:8198)\n")
        return 2
    url = f"http://{server}"
    shost = server.rsplit(":", 1)[0]
    if not _env("NODE_IP") and shost in (_detect_node_ip(), "127.0.0.1", "localhost"):
        sys.stdout.write(
            f"This machine is the server ({server}) — it is already a worker node, so "
            f"there is nothing to join. Run `kore client …` on the OTHER machine.\n")
        return 0

    # 1) client -> server: can we reach the dashboard at all?
    if not _health_url_ok(url):
        sys.stderr.write(
            f"\n✗ cannot reach the kore server at {url} from this machine.\n"
            f"    • is that the server's address as seen from THIS machine?\n"
            f"    • is the server up (`kore status` on the server)?\n"
            f"    • is port {server.rsplit(':', 1)[1]} open from this machine to the server?\n\n")
        return 1

    # 2) is the token right? Checked before touching a client that may already be running
    # here, so a typo never takes a working client down.
    tok_ok = _token_accepted(url, args.token)
    if tok_ok is False:
        sys.stderr.write(
            f"\n✗ the server at {url} rejected this token.\n"
            f"    Copy the exact join line the server shows (dashboard → 添加机器, or run\n"
            f"    `kore` on the server) — the token is the long value after --token.\n\n")
        return 1

    _set_env("BRIDGE_URL", url)
    _set_env("AGENT_TOKEN", args.token)
    if args.foreground:
        sys.stderr.write(f"[kore] joining server {url} as a worker node (foreground)\n")
        return _run(AGENT_PY, passthrough)

    if _read_client_pid():
        sys.stdout.write("a kore client is already running on this machine — restarting it "
                         "with the new settings...\n")
        _stop_client()

    os.makedirs(STATE_HOME, exist_ok=True)
    try:
        os.remove(CLIENT_STATUS)
    except OSError:
        pass
    log = open(CLIENT_LOGFILE, "a", encoding="utf-8")
    log.write(f"\n===== kore client {time.strftime('%Y-%m-%d %H:%M:%S')} -> {url} =====\n")
    log.flush()
    proc = subprocess.Popen(
        [sys.executable, os.path.join(PKG, AGENT_PY), *passthrough],
        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
        start_new_session=True, env=os.environ.copy())
    _pidfile_write(CLIENT_PIDFILE, proc.pid)
    with open(CLIENT_RUNFILE, "w", encoding="utf-8") as f:
        f.write(f"server={server}\n")

    # 3) wait for the agent's first registration (it records the outcome in CLIENT_STATUS)
    st: dict = {}
    deadline = time.time() + 20
    while time.time() < deadline:
        cur = _client_status()
        if cur.get("pid") == proc.pid:
            st = cur
            break
        if proc.poll() is not None:
            break
        time.sleep(0.25)

    def _fail(msg: str) -> int:
        _stop_client(quiet=True)
        sys.stderr.write(msg)
        return 1

    if not st:
        if proc.poll() is not None:
            sys.stderr.write(f"\n✗ the client agent exited (code {proc.returncode}). "
                             f"Last log lines:\n")
            _tail(CLIENT_LOGFILE, 12)
            _stop_client(quiet=True)
            return 1
        return _fail(f"\n✗ no answer from the server within 20s; see {CLIENT_LOGFILE}\n")
    if st.get("rejected"):
        return _fail(f"\n✗ {st.get('error')}.\n"
                     f"    Copy the exact `kore client …` line the server shows "
                     f"(dashboard → 添加机器, or `kore` on the server).\n\n")
    if not st.get("ok"):
        return _fail(f"\n✗ registration failed: {st.get('error')}\n    log: {CLIENT_LOGFILE}\n\n")

    node = st.get("node_ip", "?")
    agent_url = st.get("agent_url", "")
    sys.stdout.write(f"\n✓ joined {url} as worker node {node}  (agent {agent_url}, pid "
                     f"{proc.pid})\n")
    if st.get("reachable") is False:
        port = agent_url.rsplit(":", 1)[-1] if agent_url else "?"
        sys.stdout.write(
            f"\n⚠  but the server cannot reach this machine's agent at {agent_url}:\n"
            f"       {st.get('reach_error')}\n"
            f"   The node shows up, yet its sessions cannot be driven until this is fixed:\n"
            f"     • open TCP port {port} on this machine to the server ({shost}), or\n"
            f"     • if {node} is not the address the server should use, rejoin with\n"
            f"       KORE_NODE_IP=<reachable-ip> kore client --server {server} --token …\n")
    sys.stdout.write(f"\n  logs:  {CLIENT_LOGFILE}\n  stop:  kore down\n\n")
    return 0


_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _tmux_out(*args: str) -> tuple:
    try:
        r = subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=10)
        return r.returncode, r.stdout, r.stderr
    except FileNotFoundError:
        return 127, "", "tmux is not installed"
    except subprocess.TimeoutExpired:
        return 124, "", "tmux did not answer"


def _adopt(rest: list) -> int:
    """Bring existing tmux sessions on THIS machine under kore by renaming them into the
    prefix. Nothing inside a session changes; attached terminals stay attached. The same
    action is in the dashboard ("+ 已有 session"), which also reaches client machines."""
    ap = argparse.ArgumentParser(
        prog="kore adopt",
        description="Add existing tmux sessions on this machine to kore (renames NAME to "
                    "<prefix>NAME). With no NAME, list the sessions that can be added.")
    ap.add_argument("names", nargs="*", metavar="NAME", help="tmux session(s) to add")
    ap.add_argument("--all", action="store_true", help="add every session that can be added")
    args = ap.parse_args(rest)
    prefix = _env("BRIDGE_PREFIX", "kore-")

    rc, out, err = _tmux_out("list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}")
    if rc == 127:
        sys.stderr.write("tmux is not installed or not on PATH.\n")
        return 2
    rows = [ln.split("\t") for ln in out.splitlines() if ln.strip()] if rc == 0 else []
    existing = {r[0] for r in rows}

    def why_not(name: str) -> str:
        if name.startswith(prefix):
            return f"already managed (has the {prefix!r} prefix)"
        if not _SESSION_RE.match(name):
            return "name may only contain letters, digits, - and _"
        if len(prefix + name) > 48:
            return f"{prefix + name!r} would be longer than 48 characters"
        if prefix + name in existing:
            return f"a session named {prefix + name!r} already exists"
        return ""

    candidates = [r for r in rows if not r[0].startswith(prefix)]
    if not args.names and not args.all:
        if not candidates:
            sys.stdout.write(f"no tmux sessions without the {prefix!r} prefix on this machine.\n")
            return 0
        sys.stdout.write(f"tmux sessions on this machine that kore does not manage yet:\n\n")
        for r in candidates:
            name = r[0]
            win = r[1] if len(r) > 1 else "?"
            att = " (attached)" if len(r) > 2 and r[2] not in ("", "0") else ""
            w = why_not(name)
            sys.stdout.write(f"  {name:24} {win} window(s){att}" + (f"   — can't add: {w}" if w else "") + "\n")
        sys.stdout.write(f"\nadd one:   kore adopt <name>     (renames it to {prefix}<name>)\n"
                         f"add all:   kore adopt --all\n")
        return 0

    names = [r[0] for r in candidates if not why_not(r[0])] if args.all else args.names
    status = 0
    for name in names:
        if name not in existing:
            sys.stderr.write(f"✗ {name}: no tmux session with that name\n")
            status = 1
            continue
        w = why_not(name)
        if w:
            sys.stderr.write(f"✗ {name}: {w}\n")
            status = 1
            continue
        rc, _o, e = _tmux_out("rename-session", "-t", f"={name}", prefix + name)
        if rc != 0:
            sys.stderr.write(f"✗ {name}: {e.strip() or 'tmux rename-session failed'}\n")
            status = 1
            continue
        existing.add(prefix + name)
        sys.stdout.write(f"✓ {name} -> {prefix + name}  (now on the dashboard)\n")
    if not names:
        sys.stdout.write("nothing to add.\n")
    return status


def _client_status() -> dict:
    try:
        with open(CLIENT_STATUS, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _token_accepted(url: str, token: str):
    """True / False / None (unknown). The register door checks the Bearer token BEFORE it
    looks at the body, so an empty POST answers 401 for a wrong token and 400 for a right
    one — a token check that registers nothing."""
    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415
    req = urllib.request.Request(url.rstrip("/") + "/api/agents/register", data=b"{}",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + token},
                                 method="POST")
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=8)
        return True
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False
        return True if e.code == 400 else None
    except Exception:
        return None


def _health_url_ok(url: str, timeout: float = 5.0) -> bool:
    import urllib.request  # noqa: PLC0415
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url.rstrip("/") + "/api/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False

def _tail(path: str, n: int) -> None:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        for ln in lines[-n:]:
            sys.stderr.write("    " + ln.rstrip("\n") + "\n")
    except OSError:
        pass


def _stop_pid(pid: int) -> None:
    import signal  # noqa: PLC0415
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    for _ in range(40):                       # up to ~10s for a clean exit
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.25)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _rm(*paths: str) -> None:
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def _stop_client(quiet: bool = False) -> bool:
    pid = _read_client_pid()
    if pid:
        _stop_pid(pid)
        if not quiet:
            sys.stdout.write(f"kore client stopped (pid {pid}).\n")
    _rm(CLIENT_PIDFILE, CLIENT_RUNFILE)
    return bool(pid)


def _down(_rest: list) -> int:
    """Stop whatever kore runs on THIS machine: the background board and/or the client."""
    stopped = False
    pid = _read_pid()
    if pid:
        _stop_pid(pid)
        sys.stdout.write(f"kore server stopped (pid {pid}).\n")
        stopped = True
    _rm(PIDFILE, RUNFILE)
    if pid and os.path.exists(LEGACY_PIDFILE):
        _rm(LEGACY_PIDFILE, os.path.join(STATE_HOME, "kore.run"))
    stopped = _stop_client() or stopped
    if not stopped:
        sys.stdout.write("kore is not running on this machine.\n")
    return 0

def _status(_rest: list) -> int:
    """What kore runs on THIS machine: the board and/or a client."""
    pid, cpid = _read_pid(), _read_client_pid()
    if not pid and not cpid:
        sys.stdout.write("kore is NOT running on this machine.  Start the server with:  kore\n"
                         "  (or join a server:  kore client --server <ip:port> --token <tok>)\n")
        return 1
    rc = 0
    if pid:
        cfg = _runfile_read()
        port = cfg.get("port", os.environ.get("WB_PORT", "8198"))
        prefix = cfg.get("prefix", _env("BRIDGE_PREFIX"))
        live = _health_ok(cfg.get("host", os.environ.get("WB_HOST", "127.0.0.1")), port)
        primary, local = _link(port)
        sys.stdout.write(
            f"kore server running  —  pid {pid}, prefix={prefix}, "
            f"health={'ok' if live else 'NOT answering'}\n\n  👉  {primary}\n      {local}\n\n")
        rc = 0 if live else 1
    if cpid:
        st = _client_status()
        age = int(time.time() - float(st.get("at", 0) or 0)) if st else -1
        if st.get("ok"):
            state = f"registered as node {st.get('node_ip')}, last heartbeat {age}s ago"
            if st.get("reachable") is False:
                state += f"\n    ⚠ server cannot reach this agent: {st.get('reach_error')}"
        else:
            state = f"NOT registered: {st.get('error') or 'no heartbeat yet'}"
            rc = 1
        sys.stdout.write(f"kore client running  —  pid {cpid}, server {st.get('server', '?')}\n"
                         f"    {state}\n    log: {CLIENT_LOGFILE}\n\n")
    return rc



# --------------------------------------------------------------------------- doctor

# kore runs on old tmux by degrading; this is the version everything works at natively.
TMUX_RECOMMENDED = (3, 0)


def _tmux_version() -> tuple:
    """(raw `tmux -V` text, (major, minor) or None when unparseable — e.g. `tmux master`)."""
    try:
        tv = subprocess.run(["tmux", "-V"], capture_output=True, text=True,
                            timeout=5).stdout.strip()
    except Exception:  # noqa: BLE001
        return "", None
    m = re.search(r"(\d+)\.(\d+)", tv)
    return tv, ((int(m.group(1)), int(m.group(2))) if m else None)


def _tmux_degraded(ver: tuple) -> str:
    """What an old tmux costs, in one line."""
    if ver < (2, 9):
        return ("the dashboard cannot fit the window to the browser (resize-window needs "
                "2.9+), and typing uses a fallback path")
    return "dashboard typing uses a fallback path (send-keys -H needs 3.0+)"


def _os_release() -> dict:
    out: dict = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    out[k] = v.strip('"')
    except OSError:
        pass
    return out


def _tmux_upgrade_steps() -> list:
    """Concrete ways to get a newer tmux on THIS machine, most likely first.

    The system package manager comes first, but an old distro can only offer an old tmux
    (Ubuntu 18.04 ships 2.6), so options that do not depend on the distro follow."""
    steps: list = []
    sudo = "" if (hasattr(os, "geteuid") and os.geteuid() == 0) else "sudo "
    if sys.platform == "darwin":
        steps.append("brew install tmux        # or: brew upgrade tmux")
    else:
        osr = _os_release()
        ids = f"{osr.get('ID', '')} {osr.get('ID_LIKE', '')}".lower()
        if any(d in ids for d in ("debian", "ubuntu")) and shutil.which("apt-get"):
            steps.append(f"{sudo}apt-get update && {sudo}apt-get install -y tmux"
                         "   # older releases may still ship an old tmux")
        elif any(d in ids for d in ("rhel", "centos", "fedora", "rocky", "alma")):
            pm = "dnf" if shutil.which("dnf") else "yum"
            steps.append(f"{sudo}{pm} install -y tmux"
                         "   # EL7/EL8 repos ship tmux 1.8 / 2.7")
        elif "alpine" in ids:
            steps.append(f"{sudo}apk add tmux")
        elif "arch" in ids:
            steps.append(f"{sudo}pacman -S tmux")
        elif "suse" in ids:
            steps.append(f"{sudo}zypper install tmux")
        if shutil.which("brew"):
            steps.append("brew install tmux        # Homebrew on Linux, no root needed")
    if shutil.which("conda") or shutil.which("mamba") or shutil.which("micromamba"):
        tool = next(t for t in ("mamba", "micromamba", "conda") if shutil.which(t))
        steps.append(f"{tool} install -y -c conda-forge tmux   # recent tmux, no root needed")
    steps.append("build from source: https://github.com/tmux/tmux/releases "
                 "(needs libevent + ncurses headers; ./configure && make && make install)")
    return steps


def _detect_node_ip() -> str:
    ip = _env("NODE_IP")
    if ip:
        return ip
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def _doctor(_rest: list) -> int:
    rows: list = []   # (level, label, detail)

    def add(level, label, detail=""):
        rows.append((level, label, detail))

    add("PASS", "prefix", _env("BRIDGE_PREFIX", "kore-"))

    for tool in ("tmux", "claude"):
        where = shutil.which(tool)
        if where:
            add("PASS", f"{tool} on PATH", where)
        else:
            lvl = "WARN" if tool == "claude" else "FAIL"
            add(lvl, f"{tool} on PATH", "not found")

    # tmux version: kore degrades instead of requiring a minimum, so an old tmux is a WARN
    # with upgrade steps (printed under the table), never a FAIL.
    tmux_hint: list = []
    if shutil.which("tmux"):
        tv, ver = _tmux_version()
        if ver is None:
            add("PASS", "tmux version", tv or "unknown (assuming a recent build)")
        elif ver < TMUX_RECOMMENDED:
            add("WARN", "tmux version", f"{tv} — works, but " + _tmux_degraded(ver))
            tmux_hint = _tmux_upgrade_steps()
        elif ver < (3, 1):
            # Not a warning: kore itself gets nothing from 3.1. Outside kore, 3.1's
            # `window-size latest` sizes a window shared by several real terminals to the
            # one in use (3.0 gives every terminal the same size, clipping or padding some).
            add("PASS", "tmux version",
                f"{tv} (fine for kore; 3.1+ is nicer if you attach one session from "
                f"several terminals at once — the window follows the one you're using)")
        else:
            add("PASS", "tmux version", tv)

    token = _env("AGENT_TOKEN", "")
    if token:
        add("PASS", "agent token", "set (client /exec fenced)")
    elif os.path.exists(AGENT_TOKEN_FILE):
        add("PASS", "agent token", f"minted at {AGENT_TOKEN_FILE}")
    else:
        add("WARN", "agent token",
            "none yet — `kore server` mints one on first start")

    agents_file = _env("AGENTS_FILE", os.path.join(STATE_HOME, "agents.json"))
    adir = os.path.dirname(agents_file) or "."
    if os.path.isdir(adir) and os.access(adir, os.W_OK):
        add("PASS", "agents dir writable", adir)
    elif not os.path.exists(adir):
        add("WARN", "agents dir", f"{adir} does not exist yet (created on first write)")
    else:
        add("FAIL", "agents dir writable", adir)

    if os.path.exists(agents_file):
        try:
            import time as _t
            data = json.load(open(agents_file, encoding="utf-8"))
            ttl = float(_env("AGENT_TTL", "45"))
            now = _t.time()
            fresh = [ip for ip, r in data.items()
                     if isinstance(r, dict) and now - float(r.get("last_seen", 0)) <= ttl]
            add("PASS" if fresh else "WARN", "agents.json",
                f"{len(data)} client(s), {len(fresh)} TTL-fresh")
        except Exception as e:
            add("FAIL", "agents.json", f"unparseable: {e}")
    else:
        add("WARN", "agents.json", f"none yet at {agents_file} (no client has joined)")

    ip = _detect_node_ip()
    if ip == "127.0.0.1":
        add("WARN", "node-ip autodetect",
            "collapsed to 127.0.0.1 — set --node-ip / $KORE_NODE_IP for cross-machine use")
    else:
        add("PASS", "node-ip", ip)

    tok_file = os.environ.get("WB_TOKEN_FILE", os.path.join(STATE_HOME, "wb.token"))
    if os.path.exists(tok_file):
        mode = oct(os.stat(tok_file).st_mode & 0o777)
        add("PASS" if mode == "0o600" else "WARN", "WB token file", f"{tok_file} mode {mode}")
    else:
        add("PASS", "WB token file", f"will be generated at {tok_file}")

    width = max(len(label) for _, label, _ in rows)
    worst = 0
    rank = {"PASS": 0, "WARN": 1, "FAIL": 2}
    mark = {"PASS": "✓", "WARN": "!", "FAIL": "✗"}
    sys.stdout.write("\nkore doctor\n" + "-" * (width + 12) + "\n")
    for level, label, detail in rows:
        worst = max(worst, rank[level])
        sys.stdout.write(f"  {mark[level]} {level:4} {label.ljust(width)}  {detail}\n")
    sys.stdout.write("\n")
    if tmux_hint:
        sys.stdout.write(f"  Upgrade tmux to {'.'.join(map(str, TMUX_RECOMMENDED))}+ "
                         f"(any of these; then restart kore with `kore down && kore`):\n")
        for line in tmux_hint:
            sys.stdout.write(f"    {line}\n")
        sys.stdout.write("\n")
    return 0 if worst < 2 else 1


# --------------------------------------------------------------------------- upgrade

def _vtuple(s: str) -> tuple:
    """Parse 'v0.1.4' / '0.1.4' into a comparable (0,1,4) tuple (missing parts = 0)."""
    nums = re.findall(r"\d+", s.lstrip("vV"))[:3]
    return tuple(int(n) for n in nums) + (0,) * (3 - len(nums))


def _is_semver(s: str) -> bool:
    return bool(re.match(r"v?\d+\.\d+\.\d+$", s))


def _net_env() -> dict:
    """os.environ for subprocesses that must reach GitHub — with the real proxy restored.

    _apply_env_defaults() popped the proxy for intranet traffic; git/uv talking to GitHub
    generally need it back. We restore ONLY here, into a throwaway env dict."""
    env = os.environ.copy()
    for v in _PROXY_VARS:          # drop any we injected (NO_PROXY), then layer originals
        env.pop(v, None)
    env.update(_ORIG_PROXY)
    return env


def _gh_token() -> str:
    """A GitHub token for a PRIVATE repo, if the user exported one. Never persisted."""
    return (os.environ.get("KORE_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
            or os.environ.get("GH_TOKEN") or "")


def _git_url(tok: str = "") -> str:
    if tok:            # inline creds for the subprocess only; redacted in any echo
        return f"https://x-access-token:{tok}@github.com/{REPO}.git"
    return f"https://github.com/{REPO}.git"


def _redact(s: str) -> str:
    return re.sub(r"x-access-token:[^@]*@", "x-access-token:***@", s)


def _latest_tag(tok: str) -> tuple:
    """Highest vX.Y.Z tag on the remote, via `git ls-remote --tags`. ('', err) on failure.

    Uses git (not the REST API) so it works for a private repo with an inline token and
    through the restored proxy — the exact path we already know pushes/pulls cleanly."""
    try:
        r = subprocess.run(
            ["git", "ls-remote", "--tags", "--refs", _git_url(tok)],
            capture_output=True, text=True, env=_net_env(), timeout=30)
    except FileNotFoundError:
        return "", "git is not installed"
    except subprocess.TimeoutExpired:
        return "", "timed out reaching github.com"
    if r.returncode != 0:
        return "", _redact((r.stderr or "git ls-remote failed").strip())
    tags = []
    for ln in r.stdout.splitlines():
        name = ln.rsplit("/", 1)[-1].strip()
        if _is_semver(name):
            tags.append(name)
    if not tags:
        return "", "no vX.Y.Z tags on the remote"
    return sorted(tags, key=_vtuple)[-1], ""


def _proxy_opener():
    """A urllib opener that uses the user's ORIGINAL proxy (see _ORIG_PROXY), for upgrade's
    own GitHub calls. An empty map means no proxy, which is right when none was set."""
    import urllib.request  # noqa: PLC0415
    pmap = {}
    for scheme in ("http", "https"):
        val = (_ORIG_PROXY.get(f"{scheme}_proxy") or _ORIG_PROXY.get(f"{scheme.upper()}_PROXY")
               or _ORIG_PROXY.get("all_proxy") or _ORIG_PROXY.get("ALL_PROXY"))
        if val:
            pmap[scheme] = val
    return urllib.request.build_opener(urllib.request.ProxyHandler(pmap))


def _latest_tag_http() -> tuple:
    """Latest release tag without git: github.com/<repo>/releases/latest redirects to
    .../releases/tag/<tag>. ('', err) on failure. Public repos only."""
    try:
        with _proxy_opener().open(f"https://github.com/{REPO}/releases/latest",
                                  timeout=30) as r:
            tag = r.geturl().rstrip("/").rsplit("/", 1)[-1]
    except Exception as e:  # noqa: BLE001 - reported to the user verbatim
        return "", f"could not reach github.com ({type(e).__name__}: {e})"
    return (tag, "") if _is_semver(tag) else ("", f"no release tag in {tag!r}")


def _install_source() -> tuple:
    """How this kore was installed:
    ('script', root) | ('clone', repo_root) | ('uv-tool', '') | ('other', '')."""
    root = os.path.dirname(os.path.dirname(PKG))     # .../src/kore -> .../ (source root)
    if os.path.isfile(os.path.join(root, ".kore-install")):
        return "script", root                        # unpacked by install.sh
    if os.path.isdir(os.path.join(root, ".git")):
        return "clone", root
    if shutil.which("uv"):
        try:
            r = subprocess.run(["uv", "tool", "list"], capture_output=True, text=True,
                               timeout=10)
            if r.returncode == 0 and any(
                    ln.strip().split(" ")[0] == "kore" for ln in r.stdout.splitlines()):
                return "uv-tool", ""
        except Exception:
            pass
    return "other", ""


def _upgrade_script(root: str, ref: str) -> int:
    """Upgrade an install.sh install by re-running the installer for `ref`, in place (same
    install dir and bin dir, PATH left alone)."""
    marker: dict = {}
    try:
        with open(os.path.join(root, ".kore-install"), encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    marker[k] = v
    except OSError:
        pass
    try:
        with _proxy_opener().open(INSTALL_URL, timeout=30) as r:
            script = r.read()
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"could not download the installer {INSTALL_URL}: {e}\n")
        return 1
    env = _net_env()
    env["KORE_VERSION"] = ref
    env["KORE_INSTALL_DIR"] = os.path.dirname(root)          # root is <install_dir>/current
    if marker.get("bin_dir"):
        env["KORE_BIN_DIR"] = marker["bin_dir"]
    if marker.get("repo"):
        env["KORE_REPO"] = marker["repo"]
    env["KORE_PYTHON"] = sys.executable
    sys.stdout.write(f"  $ curl -fsSL {INSTALL_URL} | sh -s -- --version {ref}\n\n")
    return subprocess.run(["sh", "-s", "--", "--no-modify-path"], input=script,
                          env=env).returncode


def _upgrade_uvtool(ref: str, tok: str) -> int:
    spec = f"git+{_git_url(tok)}@{ref}"
    cmd = ["uv", "tool", "install", "--reinstall", spec]
    sys.stdout.write("  $ " + _redact(" ".join(cmd)) + "\n\n")
    rc = subprocess.run(cmd, env=_net_env()).returncode
    return rc


def _upgrade_clone(root: str, ref: str, explicit: bool) -> int:
    env = _net_env()
    if explicit:        # pin to a given tag/branch/sha
        subprocess.run(["git", "-C", root, "fetch", "--tags", "--quiet"], env=env)
        rc = subprocess.run(["git", "-C", root, "checkout", ref], env=env).returncode
    else:               # track the current branch forward
        rc = subprocess.run(["git", "-C", root, "pull", "--ff-only"], env=env).returncode
    return rc


def _upgrade(rest: list) -> int:
    """Update kore in place to the latest release tag (or a pinned --version).

    Figures out how kore was installed and does the right thing: a git clone is
    fast-forwarded (or checked out to the pinned ref); a `uv tool` install is reinstalled
    from git. The target defaults to the highest vX.Y.Z tag on the remote. For a PRIVATE
    repo, export KORE_GITHUB_TOKEN (or GITHUB_TOKEN/GH_TOKEN) — it is used inline for the
    git/uv subprocess only, redacted in output, and never written anywhere.
    """
    ap = argparse.ArgumentParser(
        prog="kore upgrade",
        description="Upgrade kore to the latest release (or a pinned --version).")
    ap.add_argument("--version", "--ref", dest="ref", default="", metavar="REF",
                    help="exact tag/branch/sha to install (default: latest release tag)")
    ap.add_argument("--check", action="store_true",
                    help="only report current vs latest; install nothing")
    args = ap.parse_args(rest)

    tok = _gh_token()
    kind, root = _install_source()
    cur = _VERSION

    ref, latest = args.ref, ""
    if not ref:
        latest, err = _latest_tag(tok)
        if not latest:                     # no git (typical for an install.sh install)?
            latest, err2 = _latest_tag_http()
            err = err if latest else f"{err}; {err2}"
        if not latest:
            sys.stderr.write(
                f"could not determine the latest release tag: {err}.\n"
                f"  • pin one explicitly:   kore upgrade --version vX.Y.Z\n"
                f"  • private repo? export  KORE_GITHUB_TOKEN=<token>\n")
            return 1
        ref = latest

    cur_v = _vtuple(cur) if _is_semver(cur) else None
    ref_v = _vtuple(ref) if _is_semver(ref) else None
    tag = "  (latest release)" if latest and ref == latest else ""
    sys.stdout.write(f"\nkore {cur}  →  {ref}{tag}    [{kind} install]\n")

    if cur_v and ref_v and ref_v == cur_v and not args.ref:
        sys.stdout.write("already up to date.\n\n")
        return 0
    if cur_v and ref_v and ref_v < cur_v:
        sys.stdout.write(f"note: {ref} is OLDER than the installed {cur} — this downgrades.\n")

    if args.check:
        if cur_v and ref_v and ref_v > cur_v:
            sys.stdout.write("a newer version is available — run `kore upgrade` to install.\n\n")
        return 0

    if kind == "other":
        sys.stdout.write(
            "\nkore wasn't installed via install.sh, `uv tool` or a git clone, so I can't "
            "update it in place.\n  reinstall with:\n"
            f"    curl -fsSL {INSTALL_URL} | sh\n\n")
        return 1

    sys.stdout.write("\n")
    if kind == "script":
        rc = _upgrade_script(root, ref)
    elif kind == "clone":
        rc = _upgrade_clone(root, ref, bool(args.ref))
    else:
        rc = _upgrade_uvtool(ref, tok)
    if rc != 0:
        sys.stderr.write("\nupgrade failed (see output above).\n")
        return 1
    sys.stdout.write(
        "\n✓ upgraded. A running board still runs the OLD code — apply the new one with:\n"
        "    kore down && kore\n\n")
    return 0


def main(argv=None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    _apply_env_defaults()
    commands = ["server", "client", "adopt", "down", "status", "upgrade", "mcp", "ops", "doctor"]

    # Split at the FIRST recognized subcommand: everything before it is kore's own
    # (identity flags / -h), everything after is passed through verbatim. This keeps
    # `kore ops --help` (koreops help) working — a plain subparser would swallow it.
    # Identity flags must precede the subcommand.
    idx = next((i for i, a in enumerate(raw) if a in commands), None)
    head = raw if idx is None else raw[:idx]
    command = None if idx is None else raw[idx]
    rest = [] if idx is None else raw[idx + 1:]

    p = argparse.ArgumentParser(
        prog="kore",
        description="Manage kore sessions (Claude Code in tmux) from a web dashboard or as "
                    "MCP tools. Just run `kore` (= `kore server`) to start the central node; "
                    "add machines by pasting the `kore client …` line it prints. Put identity "
                    "flags BEFORE the subcommand, e.g. `kore --agent-token $TOK server`. "
                    "Subcommands: server client adopt down status upgrade mcp ops doctor.")
    p.add_argument("-V", "--version", action="version", version=f"kore {_VERSION}")
    for flag, _suffix, helptext in _IDENTITY:
        p.add_argument(flag, help=helptext, default=None)
    # parse only the head so -h here prints kore's help, not a subcommand's
    args = p.parse_args(head)

    # identity flags -> env (applied after defaults so an explicit flag always wins; the
    # KORE_ spelling is set, which is what the entry scripts read)
    for flag, suffix, _h in _IDENTITY:
        val = getattr(args, flag.lstrip("-").replace("-", "_"))
        if val is not None:
            _set_env(suffix, val)

    # Bare `kore` (no subcommand) is the one-command start: same as `kore server`. `-h` is
    # handled above by argparse, so `kore --help` still prints help instead of starting.
    if command is None or command == "server":
        return _server(rest)
    if command == "client":
        return _client(rest)
    if command == "adopt":
        return _adopt(rest)
    if command == "down":
        return _down(rest)
    if command == "status":
        return _status(rest)
    if command == "upgrade":
        return _upgrade(rest)
    if command == "doctor":
        return _doctor(rest)
    return _run(_SCRIPTS[command], rest)


if __name__ == "__main__":
    sys.exit(main())
