#!/usr/bin/env python3
"""koreops — the one door for driving Claude Code tmux sessions on the cluster.

Why this file exists
    `kore-bridge.py` already had every verb needed to manage kore sessions
    (start/stop/send/keys/read/status); the workbench just never called them, so the
    dashboard could look but not touch. Wiring them to HTTP is R1 — but they are
    *remote writes*, so they inherit the eight boundaries M1 set for `dispatch.py`
    instead of getting a looser story of their own:

      * ONE door      — server.py never calls bridge's write verbs itself.
      * liveness      — a node is a write target only while the engine can route to it:
                        the server's own node, or a client with a fresh agent (`alive`).
      * allowlist     — the `kore` section of dispatch-allowlist.json says which nodes,
                        which verbs, which tmux keys, which cwd roots. Config, not code.
      * no shell hole — every caller-supplied byte is validated here before it can
                        reach a remote shell. bridge interpolated `cwd`,
                        `claude_path` and `key` straight into `tmux` commands; those
                        three holes were closed in the same change, but this door
                        validates independently and does not rely on that fix.
      * audit         — every attempt, refusals included, appends one line to
                        state/ccops/log.jsonl. Append-only, no delete path.
      * reversible    — these verbs act on a tmux session and nothing else. No
                        service is started, stopped or restarted anywhere.
      * not suicide   — `protected_sessions` names the sessions no write may touch. It
                        is an EMPTY list since 2026-10-10 (owner: "this project has no
                        session that needs protecting"); the interlock in `_validate()`
                        is untouched, so adding a name back protects it again with no
                        code change and no restart. Because the list is empty, the
                        "don't kill your own operator" job is done one layer up instead:
                        `self_session()` finds the tmux session this board runs in and
                        the roster marks that row `is_self`, which the frontend turns
                        into a second confirmation. That is a confirmation, not a
                        refusal — see self_session().
      * no sync wait  — `kore_send(wait=True)` blocks up to 600s. Callers get a job id
                        back immediately and poll it, so the dashboard can never hang
                        on a remote agent's thinking time.
      * no shared fate — the node-touching work runs in resident CHILD processes, not in
                        the dashboard. Reads go through ONE resident read agent child,
                        writes through ONE resident write agent child that owns bridge's
                        per-session locks — two separate processes, so a crash on either
                        side leaves the other serving and the board itself untouched. See
                        "Resident agents".

    `deny_nodes` names nodes no dashboard click may ever drive, even when they are live.
    It is EMPTY by default; the check in `_validate()` and the roster's `write_block`
    branch are always there, so adding an IP back is a config edit, not a code change.
    Any assertion about that branch must inject a synthetic IP into an in-process policy
    copy — reading the live board proves only what the list is today.

CLI
    koreops.py policy
    koreops.py roster [--cluster]
    koreops.py read   <node_ip> <name> [--lines N]
    koreops.py status <node_ip> <name>
    koreops.py start  <node_ip> <name> --cwd /path [--role ...]
    koreops.py send   <node_ip> <name> -m "..."
    koreops.py keys   <node_ip> <name> --key Escape
    koreops.py stop   <node_ip> <name>
    koreops.py jobs   [--limit N]
    koreops.py log    [--limit N]
    koreops.py probe  --kind roster-registry|roster-cluster|alive|read|status
                    [--args '{"node_ip":…}']      # internal: one-shot diagnostic
    koreops.py write-agent                          # internal, see "Resident agents"
    koreops.py read-agent                           # internal, see "Resident agents"

    Every write verb also takes --origin-run/--origin-round/--origin-task: the caller's
    claim about which loop run/round/task this write serves. Recorded in the audit,
    never checked, and never able to refuse a write. See _clean_origin().
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import importlib.util
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWLIST = os.environ.get("RSI_DISPATCH_ALLOWLIST", os.path.join(HERE, "dispatch-allowlist.json"))
AUDIT_DIR = os.environ.get("RSI_CCOPS_STATE", os.path.join(HERE, "state", "ccops"))
AUDIT_LOG = os.path.join(AUDIT_DIR, "log.jsonl")
# ROUND8: keystrokes get their own ledger. See DEFAULT_POLICY["input_log_max_bytes"] for
# why they are not in log.jsonl (keyboard-rate rows would push real writes out of
# `_rate_ok`'s 400-row window and make the 20-writes-a-minute limit looser, not tighter).
INPUT_LOG = os.path.join(AUDIT_DIR, "input.jsonl")
KORE_BRIDGE = os.environ.get("KORE_BRIDGE_PATH", os.path.join(HERE, "kore-bridge.py"))
# Only loaded to tap the SERVER'S OWN node in-process, for kore-agent's PaneTap class
# (see _tap_local). Hyphen in the filename => importlib, like bridge above, not `import`.
KORE_AGENT = os.environ.get("KORE_AGENT_PATH", os.path.join(HERE, "kore-agent.py"))

IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
CWD_RE = re.compile(r"^/[A-Za-z0-9._/+-]{0,255}$")
# `~` or `~/<path>` — a home-relative cwd. bridge's quote_path expands the leading `~` to
# "$HOME" and quotes the rest, so the same safe-character class as CWD_RE applies. This is
# the dashboard's neutral default (the per-node home dir).
HOME_CWD_RE = re.compile(r"^~(/[A-Za-z0-9._/+-]{0,255})?$")
KEY_RE = re.compile(r"^[A-Za-z0-9-]{1,16}$")
# ROUND8 `input`: keystrokes travel as HEX CODEPOINTS, never as a literal string.
# `tmux send-keys -H 1b 5b 41` types ESC [ A — the exact three bytes an arrow key sends.
# Why hex and not `send-keys -l <literal>`: the remote side is a shell, and the literal
# would have to survive `'`-escaping in a single-quoted argument on its way through
# `sh()`. A codepoint list has no quoting surface at all: this regex is the whole input
# alphabet, so there is nothing to escape and nothing to get wrong. It also makes the
# unprintable half of a terminal (ESC, C-c, C-d, arrows, F-keys) expressible without a
# second "special key" vocabulary to keep in sync with tmux's own key names.
HEX_RE = re.compile(r"^[0-9a-f]{1,6}( [0-9a-f]{1,6})*$")
ROLE_RE = re.compile(r"^[^\x00-\x1f]{0,200}$")
# R6-DASHBOARD: `origin` is the caller's claim about WHY this write happened
# ({run_id, round, task_id}), echoed verbatim into the audit so the dashboard can draw the
# "main loop round -> kore-session" edge. It is NOT a permission input: it never appears in
# _validate(), and a malformed origin must never turn an otherwise-allowed write into a
# refusal (see _clean_origin). These regexes only keep junk out of the audit log.
ORIGIN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

WRITE_VERBS = ("start", "stop", "send", "keys", "input", "resize")
"""Every verb that can change something on a remote host. Membership here is what makes
`_validate()` run (nodes / deny_nodes / protected_sessions / verbs) and what `do_POST`
checks before it will route a request at all — so a new write verb that is NOT in this
tuple is unreachable, and one that IS in it cannot skip the gate.

ROUND8 added `input` (xterm.js keystroke passthrough). It is a write like the other four
— same `_validate()`, same Bearer-only POST — with one shape difference: it is SYNCHRONOUS
and leaves no job row. See `input_keys()` for why (one ledger row per keystroke would both
evict the real writes from `job_keep` and make `max_per_minute` meaningless), and note
that `submit()` refuses it explicitly so there is exactly one door per verb.

ROUND9 added `resize` (`tmux resize-window`), same synchronous shape for the same reason:
it fires while somebody drags a browser window, not once per deliberate action. It is the
only verb here that changes nothing INSIDE the session — no bytes reach the far tty — but
it is a write all the same: tmux repaints the pane, every other client attached to that
window sees the new geometry, and `resize-window` flips that window's `window-size` option
to `manual` (verified on tmux 3.4), which outlives this request. A thing with a lasting
remote effect goes through the gate, whatever its motive."""
READ_VERBS = ("read", "status")

DEFAULT_POLICY: dict[str, Any] = {
    "enabled": True,
    "nodes": ["*"],
    # EMPTY by default: no node is denied. The CHECK in _validate() is untouched — it is the
    # mechanism, this is only its subject list; add an IP here to deny that node (e.g. a host
    # a dashboard click must never start or kill processes on) without a code change.
    "deny_nodes": [],
    "verbs": {"start": True, "stop": True, "send": True, "keys": True, "input": True,
              "resize": True},
    # Interlock, not a permission. Keep in sync with the allowlist's `kore.protected_sessions`,
    # which overrides this whole list. Empty by default: nothing is protected unless the
    # allowlist names it. The CHECK in _validate() is untouched — it is the mechanism, this
    # is only its subject list. Both lists stay the same shape of empty on purpose: a default
    # that protected MORE than the allowlist would silently re-protect sessions the day the
    # allowlist goes missing.
    "protected_sessions": [],
    # Still the SEVEN keys the four legacy buttons need, deliberately NOT widened to
    # "every key" by ROUND8. The task doc approved full-key passthrough; this list is not
    # the thing that carries it. `keys` sends ONE tmux key NAME per call through a job row
    # and a 1.5s settle — that is the shape of a button, and widening it to 200 names
    # would just be a second, worse spelling of the terminal input path. Full keys ship as
    # the `input` verb below (hex codepoints, no name vocabulary at all), which is why
    # this list can stay narrow and auditable instead of becoming an allow-everything.
    "allowed_keys": ["Enter", "Escape", "Up", "Down", "Tab", "BSpace", "C-c"],
    # ---- ROUND8 terminal emulation (read side: ANSI capture; write side: `input`) ----
    # How many scrollback lines the FIRST term frame carries. 400 ANSI lines measured
    # 41-45KB on the two live panes (vs 23-32KB with the codes stripped); a per-tick
    # repaint of the visible screen alone is 1.3-3.8KB, which is why the stream sends
    # history once and repaints the screen after that.
    "term_lines": 400,
    # Hard cap on one term payload. The ANSI text does NOT go through bridge's clean()
    # (that is the function that strips the escape codes), so its 20000-char clip does not
    # apply here and this is the only thing standing between a 100k-line scrollback and
    # the browser. Trimmed from the FRONT: the newest lines are the ones being looked at.
    "term_max_bytes": 262144,
    # One `sh()` round trip's budget for the term capture (has-session + display-message
    # + up to two capture-panes). Same order as bridge's own 20s capture timeout.
    "term_capture_timeout_s": 20,
    # Seconds between `send-keys` and the capture that comes back with it. claude-code
    # needs a frame to redraw; 0 would echo the screen as it was BEFORE the keystroke,
    # which looks exactly like a dropped key. bridge's kore_keys() uses 1.5s for the same
    # reason, which is unusable at typing speed.
    "input_settle_s": 0.12,
    # ROUND10：`echo: false` 的那条路上，一次 `sh()` 只跑一条 `tmux send-keys` —— 没有
    # settle、没有 display-message、没有 capture-pane。所以它不该共用上面那个按「抓一屏」
    # 定的预算：那个数要覆盖最坏情况下的 has-session + 两次 capture-pane，而这里只有一条
    # 命令，久到 20s 就是对面节点出了别的事，再等下去只会让浏览器那一发白挂着。
    "input_send_timeout_s": 20,
    # Keystroke budget. Separate from `max_per_minute` (20) on purpose: typing is
    # thousands of events an hour and start/stop/send/keys are twenty. Sharing one counter
    # would mean either "typing stops after 20 characters" or "twenty real writes a minute
    # becomes six hundred". Coalesced batches, not raw keys: the browser sends one POST
    # per ~25ms of typing, so 600/min is roughly ten seconds of held-down autorepeat.
    "max_input_per_minute": 600,
    # Codepoints per batch. A paste arrives as one `onData` string; this is what stops a
    # 2MB clipboard from becoming one tmux command line.
    "max_input_codepoints": 512,
    # The keystroke audit is its own file (state/ccops/input.jsonl) with its own cap, NOT
    # log.jsonl. Reason: `_rate_ok()` counts real writes inside the last 400 audit rows,
    # and keyboard-rate rows would push them out of that window — the rate limit would
    # get LOOSER the faster somebody types. Rotation is a single .1 generation; this file
    # is a keystroke ledger, not an archive.
    "input_log_max_bytes": 8388608,
    # ROUND9 `resize`: the bounds a browser box may ask a far window to become. Not
    # cosmetic limits — they are what keeps a view-fit request from being a resource
    # request: 400x200 is 80k cells, and claude-code redraws all of them. The floor
    # matters as much as the ceiling: a 1x1 window would make the far side unusable for
    # whoever attaches to it next, and the resize outlives this browser tab (tmux flips
    # that window's `window-size` to `manual`).
    "resize_min_cols": 20,
    "resize_max_cols": 400,
    "resize_min_rows": 5,
    "resize_max_rows": 200,
    # Its own minute budget, separate from both `max_per_minute` (20 real writes) and
    # `max_input_per_minute` (600 keystroke batches). A window drag coalesces client-side
    # to one request per ~250ms of quiet, so 60/min is a minute of continuous resizing.
    "max_resize_per_minute": 60,
    # ---- `tap`: the byte stream (tmux control mode), read side ------------------------
    # A capture-pane poll on a tick had visible lag (far read ~21-23ms, but the tick was
    # 1000ms idle / 130ms typing — the lag was the tick, not the node). A control-mode
    # client on the node turns that into one hop (1.2ms byte→driver, measured), and the
    # keys below are all of its budget. The tap is READ-ONLY by construction: it attaches
    # with `tmux -C attach -r` (measured: size-neutral, does not touch the far window) and
    # never issues a command on that connection. Geometry still goes through the `resize`
    # write door, because that is a write.
    # Scrollback in the first paint. Same number and the same reason as `term_lines`:
    # 400 ANSI lines measured 41-45KB on the two live panes.
    "tap_hist_lines": 400,
    # What one `pull()` may hand back. The byte stream is not clean()ed and not clipped
    # anywhere else, so this is the only thing between `yes` in a pane and the browser.
    # Overflow is NOT truncated in the middle (half an escape sequence corrupts the
    # emulator for good) — the tap drops the backlog and repaints the screen instead.
    "tap_chunk_max_bytes": 262144,
    # Concurrent taps, i.e. remote `tmux -C` processes this board may hold open at once.
    # Each one is a resident process on somebody else's node: that is the cost the poll
    # tick did not have, and this is the cap on it.
    "tap_max_streams": 8,
    # How long `pull()` waits for the first byte before coming back empty. Not a latency
    # knob (a byte returns the instant it arrives) — it is the heartbeat period: every
    # empty pull writes one `h` line down the pipe, and a reader that has gone away turns
    # that write into a broken pipe. That is the whole liveness mechanism; there is no
    # timer deciding when a tap is stale, because the pipe already knows.
    "tap_pull_wait_s": 2.0,
    "cwd_roots": ["/data", "/root", "/tmp", "/home"],
    "max_message_bytes": 16384,
    "max_per_minute": 20,
    # A read costs ~20ms on the resident read agent, so this TTL's job is only to collapse
    # the N viewers of ONE pane into one round trip per tick — and the SSE stream polls at
    # ~0.8s, so a TTL at or above that would serve the second viewer a frame that is a whole
    # tick stale. KEEP IN SYNC with dispatch-allowlist.json, which sets this key explicitly
    # and therefore overrides.
    "read_cache_s": 0.5,
    "read_cache_max": 64,
    "roster_ttl_s": 20.0,
    "cluster_ttl_s": 120.0,
    # Read-agent timeouts. probe_python "" = whatever interpreter is running us. These bound
    # how long a READ in the resident read agent may take before the parent stops waiting.
    "probe_timeout_s": 20.0,
    "cluster_probe_timeout_s": 90.0,
    "alive_stale_max_s": 300.0,
    "probe_python": "",
    "send_timeout_s": 300,
    "job_keep": 200,
    # Write isolation. The resident write agent's own stderr log is capped here.
    "write_agent_log_max_bytes": 1048576,
    "write_agent_pad_s": 60.0,
    "write_timeout_s": 240.0,
    # A keystroke is not a `send`. 240+60s is the budget for "claude-code might think for
    # four minutes"; applying it to a keypress would park the browser's POST for five
    # minutes on a wedged agent, with the pane frozen and no reason on screen.
    "input_timeout_s": 25.0,
    # Read isolation. Same shape as the write agent's log cap; the slot count bounds reads
    # in flight to the read agent — see `_read_slot()`.
    "read_agent_log_max_bytes": 1048576,
    "read_agent_slots": 8,
}


class KoreOpsError(RuntimeError):
    """A refusal. Surfaced to the caller verbatim — never swallowed into a blank panel."""


_bridge = None


def use_bridge(mod: Any) -> None:
    """Share one bridge instance with the caller.

    bridge keeps per-session threading locks in module globals; two importlib
    copies in one process would each have their own, and two concurrent sends could
    interleave keystrokes into the same pane. server.py hands us state.py's copy.
    """
    global _bridge
    _bridge = mod


def bridge():
    global _bridge
    if _bridge is None:
        spec = importlib.util.spec_from_file_location("koreops_bridge", KORE_BRIDGE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _bridge = mod
    return _bridge


_agent_mod = None


def agent_mod():
    """Load kore-agent.py as a library, for `local` mode's in-process PaneTap only."""
    global _agent_mod
    if _agent_mod is None:
        spec = importlib.util.spec_from_file_location("koreops_agent", KORE_AGENT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _agent_mod = mod
    return _agent_mod


# ------------------------------------------------------------------------ policy


def policy() -> dict[str, Any]:
    """Merge the allowlist's `kore` section over the defaults. Missing file = defaults."""
    out = dict(DEFAULT_POLICY)
    try:
        with open(ALLOWLIST, encoding="utf-8") as f:
            cfg = json.load(f)
        section = cfg.get("kore")
        if isinstance(section, dict):
            for k, v in section.items():
                if not k.startswith("_"):
                    out[k] = v
    except FileNotFoundError:
        pass
    verbs = dict(DEFAULT_POLICY["verbs"])
    verbs.update(out.get("verbs") or {})
    out["verbs"] = verbs
    return out


# ------------------------------------------------------------------------- audit


def _audit(record: dict[str, Any]) -> dict[str, Any]:
    os.makedirs(AUDIT_DIR, exist_ok=True)
    with open(AUDIT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def read_audit(limit: int = 20) -> list[dict[str, Any]]:
    try:
        with open(AUDIT_LOG, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    out: list[dict[str, Any]] = []
    for ln in lines[-limit:]:
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


def _rate_ok(max_per_minute: int) -> tuple[bool, int]:
    """Count accepted writes in the last 60s. Reads and refusals do not count."""
    now = time.time()
    recent = [
        r for r in read_audit(400)
        if r.get("verb") in WRITE_VERBS
        and r.get("action") == "accepted"
        and now - float(r.get("at_epoch", 0) or 0) < 60
    ]
    return len(recent) < max_per_minute, len(recent)


# ------------------------------------------------------------- read isolation
#
# The node-touching work runs in resident CHILD processes, not in the dashboard. The
# containment argument is simple: a child that crashes (a wedged subprocess, a far node
# that hangs an HTTP call, a segfault in anything it links) is an exit code for the parent
# to read, not a dead board. The parent sees EOF, fails the reads in flight with a reason,
# and the next read builds generation N+1. The board is never restarted.
#
# Why two agents, not one:
#   * the read agent and the write agent are DIFFERENT processes with their own locks and
#     their own generation counters, so killing either one leaves the other serving (that
#     is asserted, not asserted-by-comment: see m45/m46);
#   * `_read_dispatch()` still enumerates five read kinds explicitly and still never does
#     getattr(br, kind) — a child that can be told which function to call is a new hole,
#     not a fix.
#
# The one-shot `koreops.py probe --kind …` verb survives as a HAND-RUN DIAGNOSTIC (it runs
# one read in a throwaway child, without touching the board's agent at all) and it shares
# `_read_dispatch()` with the resident path, so it cannot rot into a second, divergent
# implementation of the same five reads.

PROBE_SENTINEL = "<<<KOREOPS-PROBE>>>"
"""A child can print log noise on stdout, so the child prefixes its one real answer and
the parent reads only that line. Without this, one stray stdout line becomes a parse error
and the panel goes blank for a reason that has nothing to do with the read."""

_PROBE_KINDS = ("roster-registry", "roster-cluster", "alive", "read", "status")
"""Reads only, and an explicit list rather than "any bridge attribute" — a child
that can be told which function to call is a new hole, not a fix.

`start` / `stop` / `send` / `keys` are NOT here and never will be. Reads and writes have
different correctness requirements and so they get different agents:

  * WRITES must be resident: bridge keeps a per-session threading lock in module
    globals (`use_bridge`), so two processes each get their own copy and two concurrent
    sends to one pane would stop being serialized. For writes, residency is CORRECTNESS.
  * READS (`kore_read` / `kore_status` / `kore_cluster` / `kore_list` / `alive_ips`) take no
    session lock at all, so for reads residency is purely crash containment plus latency.

Keeping them in two agents rather than one is what makes "a read that crashes cannot cost
a write" a structural fact instead of a hope: the write agent is a different pid, holding
different locks, counting its own generations."""


def _read_slot() -> threading.Semaphore:
    """Bound on reads in flight to the read agent.

    The resident agent answers one thread per request, so this caps how many a
    ThreadingHTTPServer with many panes open can have in flight at once — eight concurrent
    captures queue behind each other for ~20ms apiece instead of growing threads without
    limit in the child. Rebuilt when the operator changes the number, which is why this is
    a function."""
    global _read_slots
    n = max(1, int(policy().get("read_agent_slots", 8) or 8))
    with _read_slots_mu:
        if _read_slots is None or _read_slots[0] != n:
            _read_slots = (n, threading.Semaphore(n))
        return _read_slots[1]


_read_slots: tuple[int, threading.Semaphore] | None = None
_read_slots_mu = threading.Lock()


def _child_env() -> dict[str, str]:
    """Environment inherited by every resident-agent child — just the parent's own."""
    return dict(os.environ)


def _probe_python() -> str:
    """Interpreter for the child. Defaults to whatever is running us; `kore.probe_python`
    in the allowlist overrides."""
    return str(policy().get("probe_python") or sys.executable or "python3")


def _probe_timeout(kind: str) -> float:
    pol = policy()
    if kind == "roster-cluster":
        # A cluster sweep pays a long timeout per wedged node, serially in the worst
        # case, so it cannot share the registry scan's budget.
        return float(pol.get("cluster_probe_timeout_s", 90.0))
    return float(pol.get("probe_timeout_s", 20.0))


def _name_label(name: Any) -> str:
    """A refused session name, in a form that is safe to put in JSON and on a page."""
    s = "" if name is None else str(name)
    return "".join(c if c.isascii() and (c.isalnum() or c in "._-") else "?"
                   for c in s[:32])


def _roster_keep(sessions: Any, out: dict[str, Any]) -> list[Any]:
    """Keep the rows whose session name matches NAME_RE; count and name the rest.

    These names are not ours. bridge builds them by splitting `tmux ls` output on ':'
    (`kore_list`), so whatever anyone can name a tmux session on any node in the cluster
    arrives here as a string — spaces, quotes, `$(…)`, control bytes. One consumer
    downstream interpolates the name into a shell command unquoted (`_term_cmd`), and the
    thing that currently stops a bad one is bridge's `norm_name()`, i.e. a check in a
    different file that a future caller can forget to go through. A roster row is also a
    label on the page and the argument a client POSTs back, so the cheap fix is to drop
    the row at the boundary rather than ask every consumer to re-validate.

    Dropping them SILENTLY would be the wrong kind of quiet — an operator whose session
    is missing from the board has to be able to see that it was dropped, and why. So the
    count and a sanitized form of each refused name ride along in the answer.

    The rule is koreops's NAME_RE, deliberately the same one `_validate()` applies to
    writes, which is stricter than bridge's SESSION_NAME_RE on length (48 vs 64): a
    49-character session used to be readable but never writable, and one rule for "a
    session name this board will handle" is simpler than two that disagree.
    """
    kept, bad = [], []
    for s in sessions or []:
        nm = s.get("name") if isinstance(s, dict) else None
        if isinstance(nm, str) and NAME_RE.match(nm):
            kept.append(s)
        else:
            bad.append(_name_label(nm))
    out["skipped_names"] = bad
    out["skipped_name_count"] = len(bad)
    return kept


def _roster_raw(scan: str, br: Any) -> dict[str, Any]:
    """The node-touching half of `roster()`. Runs ONLY inside a read-agent child — the
    board process never calls this, which is the whole point. Post-processing (protected /
    writable / sort) stays in the parent: policy decisions do not belong in a process that
    is expected to die."""
    out: dict[str, Any] = {"sessions": [], "unreachable_nodes": [],
                           "nodes": [], "scanned_nodes": [],
                           "skipped_names": [], "skipped_name_count": 0}
    out["nodes"] = br.kore_cluster().get("nodes", [])
    if scan == "registry":
        r = br.kore_list(None, True)
        out["sessions"] = _roster_keep(r.get("sessions", []), out)
        out["unreachable_nodes"] = r.get("unreachable_nodes") or []
        out["scanned_nodes"] = sorted({s.get("node_ip") for s in out["sessions"]})
        return out
    ips = br.alive_ips()
    out["scanned_nodes"] = ips

    def one(ip: str) -> dict[str, Any]:
        try:
            return br.kore_list(ip, True)
        except Exception as exc:  # noqa: BLE001 - one bad node, not the sweep
            return {"unreachable_nodes": [ip], "sessions": [],
                    "error": f"{type(exc).__name__}: {exc}"}

    with ThreadPoolExecutor(max_workers=max(1, min(8, len(ips)))) as pool:
        for r in pool.map(one, ips):
            out["sessions"].extend(r.get("sessions") or [])
            out["unreachable_nodes"].extend(r.get("unreachable_nodes") or [])
    out["sessions"] = _roster_keep(out["sessions"], out)
    return out


_TERM_G = "<<<KORE-GEOM>>>"
_TERM_H = "<<<KORE-HIST>>>"
_TERM_S = "<<<KORE-SCREEN>>>"
"""Section markers for the one-shell-command term capture.

Three facts have to come back together or the emulation is wrong: the geometry (xterm
must be resized to the far side's cols/rows before a row-addressed repaint lands), the
cursor (a terminal without a cursor is a screenshot), and the bytes. Asking for them in
three `sh()` calls would be three round trips AND three different moments in time —
the cursor would belong to a screen that no longer exists. One command, one moment.

Markers rather than JSON because the producer is `tmux` and `printf`, not a program that
could serialize. They are printed on their own line; a pane whose own output contains one
of these strings would confuse the parser, which is why they are this ugly."""


def _term_cmd(name: str, lines: int, screen_only: bool, settle: str = "") -> str:
    """The shell command for one term capture. `name` goes in UNQUOTED, so it is checked
    here too, not only upstream (2026-10-12: upstream is `norm_name()` in a frozen file
    one import away; a check at the point of interpolation cannot be bypassed by a new
    caller that forgets it. NAME_RE is the same rule writes use).

    `has-session` first, with `&&` rather than `;`: a dead session must produce NO geometry
    section (so the parser can say "not found" instead of inventing an 80x24 blank screen)
    and, when `settle` carries a `send-keys`, must not type into whatever takes that name
    next. Keystrokes and capture share this function so an input echo cannot drift from a
    stream frame — the same two captures, parsed by the same parser."""
    if not NAME_RE.match(name or ""):
        raise KoreOpsError(f"refused: session name {name!r} must match {NAME_RE.pattern}")
    fmt = ("#{pane_width} #{pane_height} #{history_size} #{cursor_x} #{cursor_y} "
           "#{cursor_flag} #{alternate_on} #{pane_in_mode}")
    hist = "" if screen_only else (
        f"printf '%s\\n' '{_TERM_H}'; tmux capture-pane -e -p -t {name} -S -{lines} -E -1; ")
    return (f"tmux has-session -t {name} 2>/dev/null && {{ {settle}"
            f"printf '%s\\n' '{_TERM_G}'; tmux display-message -p -t {name} '{fmt}'; "
            f"{hist}"
            f"printf '%s\\n' '{_TERM_S}'; tmux capture-pane -e -p -t {name} -S 0 -E -; }}")


def _term_section(out: str, marker: str) -> str | None:
    """Text after `marker`'s line, up to the next marker line. None when absent."""
    lines = out.split("\n")
    try:
        i = lines.index(marker)
    except ValueError:
        return None
    end = len(lines)
    for j in range(i + 1, len(lines)):
        if lines[j] in (_TERM_G, _TERM_H, _TERM_S):
            end = j
            break
    return "\n".join(lines[i + 1:end])


def _term_parse(br: Any, node_ip: str, name: str, out: str, stderr: str,
                screen_only: bool, max_bytes: int) -> dict[str, Any]:
    """Turn one capture's stdout into the frame payload. Runs in a CHILD (read agent or
    write agent), which is why it takes `br` instead of importing bridge itself."""
    geom = _term_section(out, _TERM_G)
    if geom is None:
        return {"ok": False, "name": name,
                "error": f"session {name!r} not found on {node_ip}"
                         + (f" (tmux said: {stderr.strip()[:200]})" if stderr.strip() else "")}
    parts = geom.strip().split()
    if len(parts) != 8 or not all(p.lstrip("-").isdigit() for p in parts):
        return {"ok": False, "name": name,
                "error": f"tmux geometry came back unreadable: {geom.strip()[:200]!r}"}
    cols, rows, hist_size, cx, cy, cvis, alt, in_mode = (int(p) for p in parts)
    screen = _term_section(out, _TERM_S) or ""
    # tmux returns the visible pane as exactly `rows` lines (verified on both live panes:
    # 24 rows -> 24 lines, 36 -> 36). Padding anyway, because the whole repaint protocol
    # assumes it: the client writes row i of the frame at absolute row i+1, so a frame
    # that is short by one line would leave the bottom row of the viewport stale forever.
    srows = screen.split("\n")
    while srows and srows[-1] == "":
        srows.pop()
    srows = (srows + [""] * rows)[:rows]
    screen = "\n".join(srows)
    history = "" if screen_only else (_term_section(out, _TERM_H) or "")
    if alt and history:
        # The alternate screen (vim / less / anything that asked for 1049h) has no
        # scrollback of its own: `-S -400` would hand back the MAIN buffer's history,
        # which is unrelated text that happens to be behind the current screen. Showing
        # it above the pane would be a lie that looks like a feature.
        history = ""
    text = (history.rstrip("\n") + "\n" + screen) if history.strip() else screen
    raw = len(text.encode("utf-8"))
    clipped = 0
    if raw > max_bytes:
        # From the front: the newest lines are the ones somebody is looking at. Cut on a
        # line boundary so the first surviving line cannot start mid escape sequence.
        keep = text.encode("utf-8")[-max_bytes:].decode("utf-8", "ignore")
        text = keep.split("\n", 1)[1] if "\n" in keep else keep
        clipped = raw - len(text.encode("utf-8"))
    plain = br.clean(screen)
    return {"ok": True, "name": name, "state": "busy" if br.is_busy(plain) else "idle",
            "output": text, "ansi": True, "screen_only": bool(screen_only),
            "cols": cols, "rows": rows, "history_size": hist_size,
            "cursor_x": cx, "cursor_y": cy, "cursor_vis": bool(cvis),
            "alt": bool(alt), "in_mode": bool(in_mode),
            "bytes": len(text.encode("utf-8")), "clipped_bytes": clipped,
            "screen_bytes": len(screen.encode("utf-8"))}


def _term_read(br: Any, node_ip: str, name: str, lines: int,
               screen_only: bool) -> dict[str, Any]:
    """`capture-pane -e` — the same read as `kore_read`, with the escape codes LEFT IN.

    ROUND8's whole premise: `kore_read` runs the capture through bridge's `clean()`, which
    deletes exactly the bytes a terminal emulator needs (colour, box drawing attributes,
    cursor addressing). Stripping them is right for a `<pre>` snapshot and fatal for
    xterm.js, so the ANSI path is a separate read KIND rather than a flag inside kore_read —
    `kore-bridge.py` is frozen, and this composes its primitives instead of editing it.

    Read-only by construction: the command it builds is `has-session` + `display-message`
    + `capture-pane`. No `send-keys`, no `kill-session`, nothing that takes the session
    lock — reads do not serialize against each other and never have."""
    br.validate_ip(node_ip)
    full = br.norm_name(name)
    pol = policy()
    r = br.sh(node_ip, _term_cmd(full, max(1, min(2000, lines)), screen_only),
              int(pol.get("term_capture_timeout_s", 20)))
    return _term_parse(br, node_ip, full, r.get("stdout") or "", r.get("stderr") or "",
                       screen_only, int(pol.get("term_max_bytes", 262144)))


def _read_dispatch(kind: str, args: dict[str, Any], br: Any) -> Any:
    """The five reads, enumerated. The ONLY place that maps a kind to a bridge call.

    Shared by both child-side entries — the resident read agent (`_read_agent_child`,
    the serving path) and the hand-run `koreops.py probe --kind …` diagnostic. One
    implementation on purpose: two would be free to drift, and the drift would be in the
    code that decides what a read is allowed to touch.

    Explicit if/elif, never `getattr(br, kind)`: a child that can be told which function
    to call is a new hole, not a fix."""
    if kind == "alive":
        # The node TABLE, not `br.alive_ips()`: each row carries the alive/status facts
        # that `node_live` needs, which a bare IP list cannot.
        return br.kore_cluster().get("nodes", [])
    if kind in ("roster-registry", "roster-cluster"):
        return _roster_raw("cluster" if kind.endswith("cluster") else "registry", br)
    if kind == "read":
        if args.get("ansi"):
            # ROUND8: same pane, same read-only shell, higher fidelity. Explicitly a
            # BRANCH and not a different `kind`, because READ_VERBS / _PROBE_KINDS are
            # load-bearing lists that other suites assert on by equality — "a read of a
            # pane" did not become a new kind of access just because the client can now
            # render the colours.
            return _term_read(br, str(args["node_ip"]), str(args["name"]),
                              int(args.get("lines") or 120), bool(args.get("screen")))
        return br.kore_read(str(args["node_ip"]), str(args["name"]),
                          int(args.get("lines") or 120))
    if kind == "status":
        return br.kore_status(str(args["node_ip"]), str(args["name"]))
    raise KoreOpsError(f"refused: {kind!r} is not a probe kind")


def _probe_child(kind: str, args: dict[str, Any]) -> int:
    """One-shot child, for `koreops.py probe --kind …` typed by a human.

    NOT the serving path (that is the resident read agent) — it is the way to run one read
    in a throwaway child without going anywhere near the board's agents, which is what you
    want when you are debugging the agents themselves.

    Deliberately has no try/except: if the read crashes or raises, dying IS the contract."""
    data = _read_dispatch(kind, args, bridge())
    sys.stdout.write(PROBE_SENTINEL + json.dumps(data, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0


# ----------------------------------------------------------- write isolation
#
# ------------------------------------------------- Resident agents (write + read)
#
# The node-touching work runs in resident child processes so a crash there cannot take the
# dashboard with it: `/api/kore/roster` and `POST /api/kore/send` both reach a far node, and
# a far node can wedge or a subprocess can die under either.
#
# Writes can't just use one-child-per-call, and the reason is in bridge: `session_lock()`
# keeps one threading.Lock PER SESSION in module globals. Two children each get their own
# copy of that dict, so two concurrent sends to one pane would stop being serialized and
# their keystrokes would interleave into that pane. Losing the interlock to gain crash
# containment is not a trade worth making.
#
# So: exactly ONE resident child (the "write agent") owns bridge and therefore owns
# the locks. It reads one JSON request per line on stdin and answers sentinel-prefixed
# JSON lines on stdout, one thread per request — writes to different panes still run
# concurrently, writes to the SAME pane still queue behind one lock, exactly as before.
#
# Reads get a resident child too, for crash containment and latency rather than locking.
# Rather than copy ~200 lines of lifecycle, the lifecycle below is PARAMETERIZED by
# `_Role`: one implementation, two roles, and every piece of per-role mutable state
# (current agent, its lock, its generation counter) lives on the role object.
#
# Two things about that are load-bearing, not stylistic:
#
#   * `_Role.mu` is PER ROLE. `_agent_ensure()` spawns while holding it; one shared lock
#     would let one role's spawn block an unrelated role's spawn.
#   * `_Role.gen` is PER ROLE. Generations are reported to the caller and asserted on
#     (m46 case C: the first write is generation 1, its self-heal is generation 2). A
#     shared counter would make the first write generation 2, because `_validate()` ->
#     `alive_ips()` always reads before any write happens.
#
# Nothing ABOUT a role is visible to callers except through `meta()`: argv is
# [python, koreops.py, "write-agent"], the log is state/ccops/write-agent.log, meta is
# {isolated, pid, generation, up_s}, and the ack-then-retry rule is untouched.
#
# What stays HERE, in the parent, is everything that decides: policy() / _validate() /
# allowlist / protected_sessions / deny_nodes / rate limit / _audit() / the job ledger.
# A process that is expected to die must not be the one holding the rules.
#
# Lifecycle is koreops's own: spawned lazily on first use, respawned by the next caller
# after it dies. No systemd unit, no port, no second config file.

WRITE_SENTINEL = "<<<KOREOPS-WRITE>>>"
"""Same reason as PROBE_SENTINEL: a child can print log noise on stdout, so the agent's
real answers are the only lines carrying this prefix and everything else is log noise."""

AGENT_LOG = os.path.join(AUDIT_DIR, "write-agent.log")
READ_AGENT_LOG = os.path.join(AUDIT_DIR, "read-agent.log")


class _Agent:
    """Parent-side handle on one resident child. One instance per generation."""

    def __init__(self, role: "_Role", proc: subprocess.Popen, gen: int) -> None:
        self.role = role
        self.proc = proc
        self.gen = gen
        self.started_at = time.time()
        self.pending: dict[str, dict[str, Any]] = {}
        self.mu = threading.Lock()      # guards `pending` and writes to the child's stdin
        self.tail: deque[str] = deque(maxlen=60)
        self.dead = ""                  # readable death reason, set once by the reader
        self.dead_signal = ""           # "SIGABRT" etc, structured; "" if not signalled
        self.dead_rc: int | None = None

    def meta(self) -> dict[str, Any]:
        return {"isolated": True, "pid": self.proc.pid, "generation": self.gen,
                "up_s": round(time.time() - self.started_at, 1)}


class _Role:
    """Everything that differs between the write agent and the read agent.

    `cur` / `mu` / `gen` are the per-role mutable state that used to be the module
    globals `_agent` / `_agent_mu` / `_agent_gen`."""

    def __init__(self, cmd: str, log: str, label: str, sentinel: str,
                 log_cap_key: str) -> None:
        self.cmd = cmd                  # argv verb, also the thread-name prefix
        self.log = log
        self.label = label              # what the operator reads: 写代理 / 读代理
        self.sentinel = sentinel
        self.log_cap_key = log_cap_key
        self.cur: _Agent | None = None
        self.mu = threading.Lock()
        self.gen = 0


WRITE = _Role("write-agent", AGENT_LOG, "写代理", WRITE_SENTINEL,
              "write_agent_log_max_bytes")
READ = _Role("read-agent", READ_AGENT_LOG, "读代理", PROBE_SENTINEL,
             "read_agent_log_max_bytes")


def _agent_log_write(role: _Role, line: str) -> None:
    """Capped by truncation, not rotation-forever: this file exists to explain a dead
    agent, so the recent tail is what matters and an unbounded log is precisely the bug
    being avoided (09-23: 55.8G). One .1 generation is kept, nothing older."""
    cap = int(policy().get(role.log_cap_key, 1048576))
    try:
        os.makedirs(AUDIT_DIR, exist_ok=True)
        if os.path.getsize(role.log) > cap:
            os.replace(role.log, role.log + ".1")
    except OSError:
        pass
    try:
        with open(role.log, "a", encoding="utf-8") as f:
            f.write(line if line.endswith("\n") else line + "\n")
    except OSError:
        pass        # a log write must never be the reason a job fails


def _agent_death_reason(a: _Agent, rc: int | None) -> str:
    """Readable, and it names the mechanism. "取不到" with no cause is how six days got
    spent on an empty panel; a write that fails must say what killed it."""
    sig = ""
    if rc is not None and rc < 0:
        try:
            sig = signal.Signals(-rc).name
        except ValueError:
            sig = f"signal {-rc}"
    a.dead_signal, a.dead_rc = sig, rc
    tail = next((ln.strip()[:300] for ln in reversed(a.tail) if ln.strip()), "")
    if sig == "SIGABRT":
        head = f"{a.role.label}被 SIGABRT 干掉了（子进程崩了）—— 看板本身没事"
    elif sig:
        head = f"{a.role.label}被 {sig} 干掉了 —— 看板本身没事"
    else:
        head = f"{a.role.label}退出码 {rc} —— 看板本身没事"
    return f"{head}：{tail}" if tail else head


def _agent_reader(a: _Agent) -> None:
    """Demultiplex the child's answers by request id until EOF.

    EOF means the child is gone, and then every request still waiting has to be failed
    with a reason — a dead agent must not leave callers parked on an Event nobody will
    ever set."""
    try:
        for raw in a.proc.stdout:                       # type: ignore[union-attr]
            if not raw.startswith(a.role.sentinel):
                if raw.strip():
                    _agent_log_write(a.role, "[stdout] " + raw.rstrip())
                continue
            try:
                msg = json.loads(raw[len(a.role.sentinel):])
            except json.JSONDecodeError as exc:
                _agent_log_write(a.role, f"[bad-answer] {exc}: {raw[:200]!r}")
                continue
            rid = str(msg.get("rid") or "")
            with a.mu:
                slot = a.pending.get(rid)
                if slot is None:
                    continue
                if msg.get("ack"):
                    slot["acked"] = True    # receipt of the request, not of the result
                    continue
                a.pending.pop(rid, None)
                slot["res"] = msg.get("res")
            slot["ev"].set()
    except (OSError, ValueError):
        pass
    rc = a.proc.wait()
    a.dead = _agent_death_reason(a, rc)
    with a.mu:
        waiting = list(a.pending.items())
        a.pending.clear()
    for _rid, slot in waiting:
        slot["res"] = {"ok": False, "error": a.dead, "agent_died": True}
        slot["ev"].set()
    _agent_log_write(a.role,
                     f"[agent] generation {a.gen} pid {a.proc.pid} exited: {a.dead}")


def _agent_stderr(a: _Agent) -> None:
    """Drain stderr, always. A child can be chatty; an unread pipe fills at 64K and then
    the agent blocks mid-write for reasons that look like a hung node."""
    try:
        for raw in a.proc.stderr:                       # type: ignore[union-attr]
            a.tail.append(raw.rstrip())
            _agent_log_write(a.role, "[stderr] " + raw.rstrip())
    except (OSError, ValueError):
        pass


def _agent_spawn(role: _Role) -> _Agent:
    role.gen += 1
    cmd = [_probe_python(), os.path.abspath(__file__), role.cmd]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1,
                            env=_child_env())
    a = _Agent(role, proc, role.gen)
    threading.Thread(target=_agent_reader, args=(a,), daemon=True,
                     name=f"koreops-{role.cmd}{a.gen}-out").start()
    threading.Thread(target=_agent_stderr, args=(a,), daemon=True,
                     name=f"koreops-{role.cmd}{a.gen}-err").start()
    _agent_log_write(role, f"[agent] generation {a.gen} pid {proc.pid} up ({cmd[0]})")
    return a


def _agent_ensure(role: _Role) -> _Agent:
    """The self-heal: a dead agent is replaced by the next caller, and the caller that
    found the corpse pays for the respawn. The dashboard is never restarted for this."""
    with role.mu:
        a = role.cur
        if a is None or a.dead or a.proc.poll() is not None:
            role.cur = a = _agent_spawn(role)
        return a


def _agent_kill(a: _Agent, why: str) -> None:
    """Retire a generation. Its reader thread sees EOF and fails whatever it was holding."""
    _agent_log_write(a.role,
                     f"[agent] generation {a.gen} pid {a.proc.pid} retired: {why}")
    with a.role.mu:
        if a.role.cur is a:
            a.role.cur = None
    try:
        a.proc.kill()
    except OSError:
        pass


def _agent_timeout(verb: str, clean: dict[str, Any]) -> float:
    """A `send` that waits gets the caller's own budget plus a pad; everything else is a
    handful of round trips. The pad exists so bridge, not this parent, is normally the one
    that declares a remote agent too slow — reporting one timeout twice, in two different
    shapes, is how a clear error becomes a confusing one."""
    pol = policy()
    pad = float(pol.get("write_agent_pad_s", 60.0))
    if verb == "send" and clean.get("wait", True):
        return float(clean.get("timeout") or pol.get("send_timeout_s", 300)) + pad
    if verb == "input":
        # A keypress is one `has-session && send-keys && capture` on the far node. If that
        # has not answered in 25s the agent is wedged, and the useful thing to do is say
        # so while the pane is still on screen — not hold the browser's POST for five
        # minutes behind a 240+60s budget meant for "claude-code is thinking".
        return float(pol.get("input_timeout_s", 25.0))
    if verb == "resize":
        # Same shape of command (has-session && resize-window && capture), same budget,
        # same reason: a browser is waiting to repaint, not to hear about a job.
        return float(pol.get("input_timeout_s", 25.0))
    return float(pol.get("write_timeout_s", 240.0)) + pad


def _agent_call(verb: str, node_ip: str, name: str, clean: dict[str, Any]) -> dict[str, Any]:
    """Hand one already-validated write to the write agent and wait for its receipt.

    Never raises for agent trouble — same contract as `_read_call()`: the failure comes
    back as `{"ok": False, "error": <readable>}`, so the ledger gets a `failed` row with
    a cause instead of a request that silently vanished."""
    timeout = _agent_timeout(verb, clean)
    req = {"verb": verb, "node_ip": node_ip, "name": name, "params": clean}
    for attempt in (1, 2):
        a = _agent_ensure(WRITE)
        rid = f"r{int(time.time() * 1000)}-{secrets.token_hex(3)}"
        slot: dict[str, Any] = {"ev": threading.Event(), "res": None, "acked": False}
        why = ""
        with a.mu:
            if a.dead:
                continue                                  # raced a dying generation
            a.pending[rid] = slot
            try:
                a.proc.stdin.write(                       # type: ignore[union-attr]
                    json.dumps({**req, "rid": rid}, ensure_ascii=False) + "\n")
                a.proc.stdin.flush()                      # type: ignore[union-attr]
            except OSError as exc:
                a.pending.pop(rid, None)
                why = f"写代理递不进去：{type(exc).__name__}: {exc}"
        if why:
            _agent_kill(a, why)
            if attempt == 1:
                continue
            return {"ok": False, "error": why, "agent": a.meta()}
        if not slot["ev"].wait(timeout):
            _agent_kill(a, f"{verb} 超过 {timeout:.0f}s 没回执")
            return {"ok": False, "agent": a.meta(),
                    "error": f"写代理 {timeout:.0f}s 没给回执，已回收重建（看板没事）；"
                             f"这次 {verb} 的真实结果未知，先 read 一眼 pane 再决定重试"}
        res = slot["res"]
        if not isinstance(res, dict):
            return {"ok": False, "error": "写代理的回执不是一个 JSON 对象", "agent": a.meta()}
        if res.pop("agent_died", False) and attempt == 1 and not slot["acked"]:
            # Died before it even acknowledged the request: provably not executed, so a
            # retry cannot double-send keystrokes. An ACKED request is never retried —
            # "did it type half the message" is not a question a retry can answer.
            _agent_log_write(WRITE,
                             f"[agent] {verb} never acked before the agent died; retrying once")
            continue
        return {**res, "agent": a.meta()}
    return {"ok": False, "error": "写代理连起两次都没接住这次写 —— 这次写没有执行，"
                                  "原因看 state/ccops/write-agent.log"}


def _read_call(kind: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run one read on the resident read agent and bring back its answer.

    Contract (every caller and every downstream `probe.*` reader depends on it):

        {"ok": True,  "probe": meta, "data": …}
        {"ok": False, "probe": meta, "error": <readable, names the mechanism>}

    `meta` carries `isolated: True` (the boundary is a process boundary) and the
    mechanical facts `pid` / `generation` / `up_s`.

    Retried ONCE, and only when the agent died without answering. Reads are idempotent
    so there is no ack rule to respect (unlike `_agent_call`), but a TIMEOUT is not
    retried: a hung read is not made less hung by asking twice, and doubling the wall
    clock on the way to the same answer is how a slow panel becomes a stuck one."""
    if kind not in _PROBE_KINDS:
        raise KoreOpsError(f"refused: {kind!r} is not a probe kind")
    timeout = _probe_timeout(kind)
    meta: dict[str, Any] = {"kind": kind, "isolated": True, "timeout_s": timeout}
    t0 = time.monotonic()
    last = ""
    for attempt in (1, 2):
        a = _agent_ensure(READ)
        meta.update(a.meta())
        # A corpse's facts belong to the generation that produced them: if attempt 1 died
        # of SIGABRT and attempt 2 answers, the answer must not carry attempt 1's signal.
        meta.pop("signal", None)
        meta.pop("exit_code", None)
        rid = f"q{int(time.time() * 1000)}-{secrets.token_hex(3)}"
        slot: dict[str, Any] = {"ev": threading.Event(), "res": None, "acked": False}
        # The slot is held across the handoff AND the wait, not just the wait: the point
        # is to bound how many requests the child has in flight, and by the time stdin is
        # flushed the child has already started a thread for it.
        with _read_slot():
            why = ""
            with a.mu:
                if a.dead:
                    last = a.dead
                    continue                              # raced a dying generation
                a.pending[rid] = slot
                try:
                    a.proc.stdin.write(                   # type: ignore[union-attr]
                        json.dumps({"rid": rid, "kind": kind, "args": args or {}},
                                   ensure_ascii=False) + "\n")
                    a.proc.stdin.flush()                  # type: ignore[union-attr]
                except OSError as exc:
                    a.pending.pop(rid, None)
                    why = f"读代理递不进去：{type(exc).__name__}: {exc}"
            if why:
                _agent_kill(a, why)
                last = why
                if attempt == 1:
                    continue
                meta.update(duration_s=round(time.monotonic() - t0, 2), timed_out=False)
                return {"ok": False, "probe": meta, "error": why}
            got = slot["ev"].wait(timeout)
        meta.update(duration_s=round(time.monotonic() - t0, 2))
        if not got:
            _agent_kill(a, f"{kind} 超过 {timeout:.0f}s 没回话")
            meta["timed_out"] = True
            return {"ok": False, "probe": meta,
                    "error": f"读代理超过 {timeout:.0f}s 没回话，已回收重建（看板本身没事）"}
        meta["timed_out"] = False
        res = slot["res"] if isinstance(slot["res"], dict) else {}
        if res.get("agent_died"):
            # The crash path. `a.dead_*` were set by the reader thread while it was
            # collecting the corpse, so the signal is a FIELD here, not a substring of a
            # sentence — m45 asserts on `probe.signal == "SIGABRT"`.
            meta.update(exit_code=a.dead_rc)
            if a.dead_signal:
                meta["signal"] = a.dead_signal
            last = a.dead
            if attempt == 1:
                continue
            return {"ok": False, "probe": meta, "error": a.dead}
        if not res.get("ok"):
            return {"ok": False, "probe": meta,
                    "error": str(res.get("error") or "读代理没说清为什么失败")}
        return {"ok": True, "probe": meta, "data": res.get("data")}
    meta.setdefault("duration_s", round(time.monotonic() - t0, 2))
    meta.setdefault("timed_out", False)
    return {"ok": False, "probe": meta,
            "error": last or "读代理连起两次都没接住这次读 —— "
                             "原因看 state/ccops/read-agent.log"}


def _send_bytes_cmd(full: str, raw: bytes) -> str:
    """Shell command that types the bytes `raw` into session `full`, on any tmux version.

    `send-keys -H <hex …>` (tmux >= 3.0) sends exact bytes. Older tmux lacks `-H`, so on
    failure we fall back to `send-keys -l` (literal, available far longer) with the same
    bytes rebuilt by POSIX `printf '%b'` from octal escapes. Nothing caller-supplied is
    quoted here: both encodings are generated from validated bytes, so the only characters
    that reach the shell are hex digits, backslashes and octal digits. The trailing `X`
    survives command substitution's newline stripping and is removed with `${k%X}`.
    """
    hexs = " ".join(f"{b:02x}" for b in raw)
    octs = "".join(f"\\0{b:03o}" for b in raw)
    return (f"{{ tmux send-keys -t {full} -H {hexs} 2>/dev/null || "
            f"{{ k=\"$(printf '%b' '{octs}X')\"; tmux send-keys -t {full} -l -- \"${{k%X}}\"; }}; }}")


def _input_apply(br: Any, node_ip: str, name: str, p: dict[str, Any]) -> dict[str, Any]:
    """Type validated codepoints into a pane and bring back the screen they produced.

    Runs in the WRITE agent, under bridge's per-session lock, for the same reason
    `kore_send` does: two viewers typing into one pane must not interleave half a keystroke
    sequence (an arrow key is three bytes; ESC alone means something else entirely).

    One `sh()` call does send + settle + geometry + capture. Not three: the echo has to be
    the screen THIS keystroke produced, and three round trips would be three different
    screens, the last of which could already include somebody else's keystroke.

    ROUND10: `echo=False` drops the settle and the capture — see the branch below. The
    caller that asks for it is one that already has a byte stream on the same pane, so the
    screen in the receipt would be both redundant and older than what it is already
    showing. Nothing else about the call changes.
    """
    br.validate_ip(node_ip)
    full = br.norm_name(name)
    pol = policy()
    settle = float(pol.get("input_settle_s", 0.12))
    hx = str(p.get("hex") or "")
    if not HEX_RE.match(hx):
        # Belt and braces: this already went through _validate_params in the parent. The
        # child re-checks because it is the process that holds the shell, and "the caller
        # validated it" is not a property the shell can see.
        return {"ok": False, "error": f"refused: hex {hx[:40]!r} is not a codepoint list"}
    # ROUND8 阶段2，真目标实测逼出来的一行：tmux 3.4 的 `send-keys -H` 收的是**字节**，
    # 不是码点 —— man 的原话是 "a hexadecimal number for an ASCII character"。实测
    # `send-keys -H 952e`（键）退出码 0、屏上一个字都不出：它不报错，它静悄悄地吞掉。
    # 所以在挨着 tmux 的这一行把码点按 UTF-8 展开，送过去的正是一个真终端在有人用输入法
    # 打出「键」时放到 tty 上的东西（e9 94 ae）。
    # 线上协议故意不改（浏览器发的仍是码点，一个汉字一个键）：码点才是「一次按键」的单位，
    # 字节只是 tmux 这一层的方言，翻译就该发生在方言的边界上，而不是让浏览器去懂 tmux。
    try:
        raw = b"".join(chr(int(c, 16)).encode("utf-8") for c in hx.split(" ") if c)
    except (ValueError, OverflowError, UnicodeEncodeError) as exc:
        return {"ok": False, "error": f"refused: hex {hx[:40]!r} 翻不成 UTF-8：{exc}"}
    # ROUND10：回执里那一屏现在是**可选的**，默认仍然带（`echo` 不传 = True，所以老的
    # 调用方、CLI、bridge 那边一个字都不用改）。
    # 为什么要有这条路：ROUND10 之前，浏览器唯一能看见自己打的字的办法就是这一屏 ——
    # 服务端的行 diff 是拿它自己上一拍抓的屏比出来的，一个刚打进去的字在它眼里不算「变了」。
    # 所以每一发按键都得等 settle + 抓一整屏，真板子实测 140ms/批（0.12s 是 settle，剩下
    # 是抓屏），而客户端一次只许一发在路上 —— 连打的时候是一卡一卡地往外蹦，owner 的原话
    # 是「发送好像 也有点不正常」。
    # 字节流（`tap`，tmux 控制模式）上来之后那一屏就是死重：对面产生的字节 1.5-2.0ms 就
    # 到驱动了（实测），回执再带一屏回来，带的还是**更旧**的那一瞬。所以让调用方说一声
    # 「我有别的路看屏」，这一发就只剩 send-keys 本身。
    # 省掉的只有「看」，没有省掉任何一道闸：Bearer + POST + confirm、_validate 的码点字母
    # 表、600/min、per-session lock，上面每一行都照跑。ok 仍然是真的 —— rc≠0 就是没落下去。
    if not bool(p.get("echo", True)):
        with br.session_lock(node_ip, full):
            r = br.sh(node_ip, _send_bytes_cmd(full, raw),
                      int(pol.get("input_send_timeout_s", 20)))
        rc = int(r.get("rc") or 0)
        err = (r.get("stderr") or "").strip()
        return {"ok": rc == 0, "echo": False, "screen_only": True,
                "error": "" if rc == 0 else (err or f"tmux send-keys 退出码 {rc}")[:200],
                "sent_codepoints": len([c for c in hx.split(" ") if c]),
                "sent_bytes": len(raw)}
    settle_cmd = f"{_send_bytes_cmd(full, raw)}; sleep {settle:.3f}; "
    with br.session_lock(node_ip, full):
        r = br.sh(node_ip,
                  _term_cmd(full, 0, True, settle=settle_cmd),
                  int(pol.get("term_capture_timeout_s", 20)))
    res = _term_parse(br, node_ip, full, r.get("stdout") or "", r.get("stderr") or "",
                      True, int(pol.get("term_max_bytes", 262144)))
    res["sent_codepoints"] = len(hx.split(" "))
    res["sent_bytes"] = len(raw)
    return res


_RESIZE_DEFERRED = "<<<KORE-RESIZE-DEFERRED>>>"


def _resize_apply(br: Any, node_ip: str, name: str, p: dict[str, Any]) -> dict[str, Any]:
    """Fit the far window to the browser's box — unless a real terminal is attached — and
    bring back the screen that produced.

    Same shape as `_input_apply` and for the same reasons: one `sh()` so the geometry in
    the receipt is the geometry this call created (two round trips could straddle somebody
    else's resize), and under the per-session lock so a resize cannot land between a
    keystroke and its capture.

    A human's own terminal always wins over the browser:
      * if any NON-control client is attached to the session (someone ran `tmux attach`),
        the window is left to size itself from that terminal and the browser adapts to the
        far geometry instead (the receipt carries `deferred: True`). Anything we cannot
        classify counts as a real terminal — when unsure, do not take the window;
      * otherwise the window is resized to the box, and then IMMEDIATELY released.
        `tmux resize-window` pins the window's `window-size` option to `manual`, which would
        clip any terminal that attaches later. Unsetting the window-level option
        (`set-option -w -u`) hands sizing back to whatever the user's tmux default is, on
        every tmux version — no version-specific value like `latest` (3.1+) is written. With
        no sizing client attached tmux keeps the geometry we just set; the moment a real
        terminal attaches, the window follows it.

    Portability: `resize-window` / `window-size` need tmux >= 2.9. On older tmux both fail
    and are ignored (stderr dropped) — the window simply keeps its own size and the browser
    adapts. `auto` is accepted for compatibility and is now always implied.
    """
    br.validate_ip(node_ip)
    full = br.norm_name(name)
    pol = policy()
    cols, rows = int(p.get("cols") or 0), int(p.get("rows") or 0)
    # %d, not a string: the only characters that can reach the far shell from here are
    # digits. The bounds were checked in the parent; re-check the shape in the process that
    # actually holds the shell, like _input_apply does.
    if not (0 < cols < 10000 and 0 < rows < 10000):
        return {"ok": False, "error": f"refused: resize {cols}x{rows} is not a geometry"}
    release = f"tmux set-option -t {full} -w -u window-size 2>/dev/null; "
    pre = (
        # Any attached client whose control-mode flag is not exactly "1" is a real terminal
        # (kore's own taps are control clients). An unsupported format prints "" -> real.
        f"if tmux list-clients -t {full} -F '#{{client_control_mode}}' 2>/dev/null "
        f"| grep -qv '^1$'; then "
        f"printf '%s\\n' '{_RESIZE_DEFERRED}'; {release}"
        f"else tmux resize-window -t {full} -x {cols:d} -y {rows:d} 2>/dev/null; {release}"
        f"fi; ")
    with br.session_lock(node_ip, full):
        r = br.sh(node_ip,
                  _term_cmd(full, 0, True, settle=pre),
                  int(pol.get("term_capture_timeout_s", 20)))
    out = r.get("stdout") or ""
    res = _term_parse(br, node_ip, full, out, r.get("stderr") or "",
                      True, int(pol.get("term_max_bytes", 262144)))
    res["deferred"] = _RESIZE_DEFERRED in out.split("\n")
    res["asked"] = {"cols": cols, "rows": rows, "auto": True}
    return res


def _write_agent_child() -> int:
    """The resident child. Owns bridge, therefore owns `session_lock()`; one thread per
    request, so different panes stay concurrent while one pane stays serialized.

    Like `_probe_child` it has no blanket guard: if the child crashes, dying IS the
    contract — the parent reads the corpse, fails that one job, and respawns."""
    br = bridge()
    out_mu = threading.Lock()

    def answer(obj: dict[str, Any]) -> None:
        with out_mu:
            sys.stdout.write(WRITE_SENTINEL + json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def handle(req: dict[str, Any]) -> None:
        rid, verb = str(req.get("rid") or ""), str(req.get("verb") or "")
        ip, name = str(req.get("node_ip") or ""), str(req.get("name") or "")
        p = req.get("params") or {}
        answer({"rid": rid, "ack": True})    # receipt first: it is what makes retry safe
        try:
            if verb == "start":
                res = br.kore_start(ip, name, str(p.get("cwd") or ""), str(p.get("role") or ""))
            elif verb == "stop":
                res = br.kore_stop(ip, name)
            elif verb == "send":
                res = br.kore_send(ip, name, str(p.get("message") or ""),
                                 bool(p.get("wait", True)), int(p.get("timeout") or 300))
            elif verb == "keys":
                res = br.kore_keys(ip, name, str(p.get("key") or ""))
            elif verb == "input":
                res = _input_apply(br, ip, name, p)
            elif verb == "resize":
                res = _resize_apply(br, ip, name, p)
            else:
                # Six explicit verbs, never getattr(br, verb): a child that can be told
                # which function to call is a new hole, not a fix.
                res = {"ok": False, "error": f"refused: {verb!r} is not a write verb"}
        except Exception as exc:  # noqa: BLE001 - a failed write is reported, not lost
            res = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        answer({"rid": rid, "res": res})

    while True:
        line = sys.stdin.readline()
        if not line:                         # parent gone: nothing left to serve
            return 0
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        threading.Thread(target=handle, args=(req,), daemon=True,
                         name=f"wa-{req.get('rid')}").start()


def _read_agent_child() -> int:
    """The resident READ child. Same shape as `_write_agent_child`, different job.

    One thread per request, so a slow sweep against a wedged node does not park the pane
    captures queued behind it. Unlike the write child there is no session lock to own here
    — reads take none — so concurrency inside this process is free.

    The difference from `_write_agent_child` worth stating: this one DOES wrap the work in
    `except Exception`. A read that raises is a read that failed, and the caller is a panel
    that must render a reason; killing the whole agent (and with it every other pane's
    capture) over one bad session name would be a worse answer. A hard crash (a signal, not
    an exception) still takes this process down — the parent reads the corpse, and
    generation N+1 serves the next read.
    """
    br = bridge()
    out_mu = threading.Lock()

    def answer(obj: dict[str, Any]) -> None:
        with out_mu:
            sys.stdout.write(PROBE_SENTINEL + json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def handle(req: dict[str, Any]) -> None:
        rid, kind = str(req.get("rid") or ""), str(req.get("kind") or "")
        args = req.get("args") or {}
        try:
            res = {"ok": True, "data": _read_dispatch(kind, args, br)}
        except Exception as exc:  # noqa: BLE001 - a failed read is reported, not lost
            res = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        answer({"rid": rid, "res": res})

    while True:
        line = sys.stdin.readline()
        if not line:                         # parent gone: nothing left to serve
            return 0
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        threading.Thread(target=handle, args=(req,), daemon=True,
                         name=f"ra-{req.get('rid')}").start()


# -------------------------------------------------------------------- validation

_alive_cache: tuple[float, list[dict[str, Any]]] | None = None

_JOB_DEAD_STATES = ("stopped", "error", "timeout")
"""Optional per-node status values that mean the node is no longer ours to write to. The
engine leaves `status` empty for a routable node; this list exists so a deployment that
DOES populate it (a scheduler in front of the nodes) can mark a node unwritable without a
code change. An empty status counts as live — see `node_live`."""


def node_live(node: dict[str, Any]) -> tuple[bool, str, str]:
    """(live?, reason, source) for one node table row.

    Two questions:

      1. Is the node routable? `job_map()` lists the server's own node plus every client
         with a fresh agent and marks each `alive: True`; a row that is not `alive` is a
         node the engine can no longer reach.
      2. Is its status a dead one? The engine leaves `status` empty, so this only matters
         when something upstream populates it; a dead status (stopped/error/timeout) means
         writing into a pane there would land work in a session about to be torn down.

    An UNKNOWN status (empty string) counts as live: that is the normal case, and treating
    it as dead would make every node unwritable.
    """
    ip = str(node.get("node_ip") or "")
    if not node.get("alive"):
        return False, f"{ip} 不在可路由的节点里（没有存活的 agent）", "engine"
    st = str(node.get("status") or "").strip().lower()
    if st in _JOB_DEAD_STATES:
        job = str(node.get("job_name") or "?")
        return False, f"节点状态是 {st}（{job}），这个节点不再属于我们", "engine"
    return True, "节点可路由（本机或有存活 agent）", "engine"


def node_liveness(force: bool = False) -> dict[str, Any]:
    """The whole liveness answer: per-node decision + the derived writable IP list.

    Asked on the other side of a process boundary (the read agent), and a failed ask falls
    back to the last good node table while it is younger than `alive_stale_max_s`, then
    fails closed. Both halves matter — an empty list refuses *every* write, so treating a
    30s-old table as fatal turns a transient hiccup into a locked-out dashboard; but a
    2-hour-old table could name a node that has since gone away, so it does expire.

    Reached from `_validate()` -> `alive_ips()` on every read and every write, so it is
    cached (`roster_ttl_s`): without the cache every frame of an SSE pane would re-ask.
    """
    global _alive_cache
    pol = policy()
    ttl = float(pol.get("roster_ttl_s", 20.0))
    stale = False
    err = ""
    probe: dict[str, Any] = {}
    nodes: list[dict[str, Any]] | None = None
    if not force and _alive_cache and time.time() - _alive_cache[0] < ttl:
        nodes = _alive_cache[1]
    else:
        res = _read_call("alive")
        probe = res.get("probe") or {}
        if res.get("ok"):
            nodes = [n for n in (res.get("data") or []) if isinstance(n, dict)]
            _alive_cache = (time.time(), nodes)
        else:
            err = str(res.get("error") or "")
            if _alive_cache and (time.time() - _alive_cache[0]
                                 < float(pol.get("alive_stale_max_s", 300.0))):
                nodes, stale = _alive_cache[1], True
    if nodes is None:
        return {"ok": False, "stale": False, "error": err, "nodes": [], "alive": [],
                "probe": probe}
    out = []
    for n in nodes:
        live, why, srcs = node_live(n)
        out.append({**n, "live": live, "reason": why, "liveness_source": srcs})
    return {"ok": not err, "stale": stale, "error": err, "nodes": out,
            "alive": [str(n["node_ip"]) for n in out if n["live"]], "probe": probe}


def alive_ips(force: bool = False) -> list[str]:
    """IPs that may be written to. `nodes: ["*"]` is bounded by this list.

    It is the `node_live` decision over the routable node table (self + fresh client
    agents), so a node that stops being routable stops being a write target."""
    return node_liveness(force=force)["alive"]


def full_name(name: str) -> str:
    """The tmux session name bridge will actually use (adds the configured prefix,
    default `kore-`; see TMUX_PREFIX / KORE_BRIDGE_PREFIX)."""
    prefix = getattr(bridge(), "TMUX_PREFIX", "kore-")
    return name if name.startswith(prefix) else prefix + name


def _self_tmux_descendants() -> dict[int, str]:
    """pid -> tmux session name, for every pane pid on this host and its descendants.

    `tmux list-panes -a` gives one pid per pane (the pane's shell); the board is a
    grandchild of that shell, so the pid itself is never in the list. We therefore walk
    /proc children downwards from each pane pid.
    """
    out: dict[int, str] = {}
    try:
        r = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"],
                           capture_output=True, text=True, timeout=5.0)
    except Exception:
        return out
    if r.returncode != 0:
        return out
    roots: list[tuple[int, str]] = []
    for line in (r.stdout or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            roots.append((int(parts[1]), parts[0]))
    for pid, sess in roots:
        stack = [pid]
        seen = set()
        while stack:
            p = stack.pop()
            if p in seen:
                continue
            seen.add(p)
            out.setdefault(p, sess)
            try:
                with open(f"/proc/{p}/task/{p}/children", "r") as fh:
                    kids = fh.read().split()
            except OSError:
                continue
            stack.extend(int(k) for k in kids if k.isdigit())
    return out


def self_session() -> str | None:
    """The tmux session THIS process runs in, or None if it cannot be established.

    R7FIX-3 任务四④. Recomputed on every call on purpose: the board is a long-lived
    process and the answer is a property of the environment it was started in, not a
    constant to bake in at import time — and a stale constant here would put the extra
    confirmation on the wrong row.

    Three ways, in order of how much they can be trusted:

      1. `KORE_SELF_SESSION` — explicit override, for a deployment with no tmux at all.
      2. `$TMUX_PANE` / `$TMUX` — inherited from whoever started the board. service.sh
         uses nohup and does not scrub the environment, so starting the board from
         inside a tmux pane gives the real answer with no guessing.
      3. the /proc descendant walk — covers the case where the environment was lost
         (e.g. the board was re-parented to init) but the process tree still ends at a
         tmux pane.

    Unknown is `None`, and `None` must never block or confirm anything: not knowing
    which session we are in is not evidence that a write is self-directed. The refusal
    side of this file is untouched — see roster()'s `is_self`, which only ever adds a
    *frontend* confirmation.
    """
    env = (os.environ.get("KORE_SELF_SESSION") or "").strip()
    if env:
        return env
    pane = (os.environ.get("TMUX_PANE") or "").strip()
    if pane and (os.environ.get("TMUX") or "").strip():
        try:
            r = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#S"],
                               capture_output=True, text=True, timeout=5.0)
            if r.returncode == 0 and (r.stdout or "").strip():
                return r.stdout.strip()
        except Exception:
            pass
    tree = _self_tmux_descendants()
    if tree:
        pid = os.getpid()
        for _ in range(64):
            if pid in tree:
                return tree[pid]
            if pid <= 1:
                break
            try:
                with open(f"/proc/{pid}/stat", "rb") as fh:
                    blob = fh.read()
                pid = int(blob[blob.rindex(b")") + 2:].split()[1])
            except Exception:
                break
    return None


def write_block_reason(nm: str, ip: str, protected: set[str] | list[str],
                       denied: set[str] | list[str], live: bool, why: str) -> str:
    """Why a write to `nm` on `ip` would be refused, or "" if it would not.

    Pulled out of roster() so the three branches can be exercised directly. Each branch
    names the rule that fired and nothing else, because this string is shown to the
    operator verbatim (index.html renders `s.write_block` as the badge title) and a reason
    that is one rule off is worse than no reason at all. "Don't write to your own board"
    is a separate mechanism — `is_self` + self_session() — not a branch here.

    Order matters and matches _validate(): the allowlist rules are cheap and
    unconditional, liveness is the one that depends on the node being reachable.
    """
    if nm in protected:
        return f"{nm} 在 protected_sessions 名单里"
    if ip in denied:
        return f"节点 {ip} 在 deny_nodes 里"
    return "" if live else why


def _validate(pol: dict[str, Any], verb: str, node_ip: str, name: str,
              params: dict[str, Any]) -> dict[str, Any]:
    """Every rejection path lives here. Returns the cleaned params.

    Deliberately strict rather than clever: a value that does not match one of these
    regexes is refused instead of escaped, because the remote side is a shell.
    """
    if not pol.get("enabled", True):
        raise KoreOpsError("refused: kore operations are disabled in the allowlist")
    if verb in WRITE_VERBS and not pol["verbs"].get(verb, False):
        raise KoreOpsError(f"refused: verb {verb!r} is disabled in the allowlist")
    if not IP_RE.match(node_ip or "") or not all(0 <= int(p) <= 255 for p in node_ip.split(".")):
        raise KoreOpsError(f"refused: {node_ip!r} is not an IPv4 address")
    if node_ip in (pol.get("deny_nodes") or []):
        raise KoreOpsError(f"refused: {node_ip} is in deny_nodes (a node this board must never drive)")
    if not NAME_RE.match(name or ""):
        raise KoreOpsError(f"refused: session name {name!r} must match {NAME_RE.pattern}")
    if verb in WRITE_VERBS and full_name(name) in (pol.get("protected_sessions") or []):
        raise KoreOpsError(
            f"refused: {full_name(name)!r} is in protected_sessions — somebody is working "
            f"in it, so {verb} from this workbench is never allowed (reads still are)"
        )
    # Node membership last: it is the only check that costs a round trip, so an obviously
    # bad request is refused without touching any node at all.
    clean = _validate_params(pol, verb, params)
    allowed = pol.get("nodes") or []
    if "*" in allowed:
        live = alive_ips()
        if node_ip not in live:
            raise KoreOpsError(f"refused: {node_ip} is not a routable node. routable: {', '.join(live)}")
    elif node_ip not in allowed:
        raise KoreOpsError(f"refused: {node_ip} is not in kore.nodes. allowed: {', '.join(allowed)}")
    return clean


def _validate_params(pol: dict[str, Any], verb: str, params: dict[str, Any]) -> dict[str, Any]:
    """Per-verb argument checks. Anything a caller types goes through here."""
    clean: dict[str, Any] = {}
    if verb == "start":
        cwd = str(params.get("cwd") or "")
        home = bool(HOME_CWD_RE.match(cwd))
        if not home and not CWD_RE.match(cwd):
            raise KoreOpsError(
                f"refused: cwd {cwd!r} must be an absolute path or ~ / ~/<path>")
        if ".." in cwd.split("/"):
            raise KoreOpsError("refused: cwd may not contain '..'")
        # A home-relative cwd (~ or ~/<path>) is the per-node home dir, the safe default, so
        # it is always allowed; cwd_roots only bounds absolute paths.
        roots = pol.get("cwd_roots") or []
        if not home and roots and not any(
                cwd == r or cwd.startswith(r.rstrip("/") + "/") for r in roots):
            raise KoreOpsError(f"refused: cwd {cwd!r} is outside cwd_roots {roots}")
        role = str(params.get("role") or "")
        if not ROLE_RE.match(role):
            raise KoreOpsError("refused: role contains control characters")
        clean = {"cwd": cwd, "role": role}
    elif verb == "send":
        msg = params.get("message")
        if not isinstance(msg, str) or not msg.strip():
            raise KoreOpsError("refused: empty message")
        nbytes = len(msg.encode("utf-8"))
        cap = int(pol.get("max_message_bytes", 16384))
        if nbytes > cap:
            raise KoreOpsError(f"refused: message is {nbytes}B, limit is {cap}B")
        if "\n" in msg:
            # tmux send-keys would submit at the first newline and leave the rest typed
            # into a fresh prompt: a silently truncated instruction.
            raise KoreOpsError("refused: message contains a newline — send one line per call")
        clean = {"message": msg, "wait": bool(params.get("wait", True)),
                 "timeout": int(params.get("timeout") or pol.get("send_timeout_s", 300))}
    elif verb == "keys":
        key = str(params.get("key") or "")
        if not KEY_RE.match(key) or key not in (pol.get("allowed_keys") or []):
            raise KoreOpsError(
                f"refused: key {key!r} is not in allowed_keys {pol.get('allowed_keys')}")
        clean = {"key": key}
    elif verb == "input":
        # The whole alphabet is this regex. Nothing here is escaped on the way to the
        # remote shell because nothing here CAN be: lowercase hex and single spaces.
        hx = str(params.get("hex") or "").strip()
        if not hx:
            raise KoreOpsError("refused: input needs a hex codepoint list, e.g. '1b 5b 41'")
        if not HEX_RE.match(hx):
            raise KoreOpsError(
                f"refused: hex {hx[:40]!r} must be space-separated lowercase codepoints "
                f"matching {HEX_RE.pattern}")
        cps = hx.split(" ")
        cap = int(pol.get("max_input_codepoints", 512))
        if len(cps) > cap:
            raise KoreOpsError(f"refused: {len(cps)} codepoints in one batch, limit is {cap}")
        for c in cps:
            if int(c, 16) > 0x10FFFF:
                raise KoreOpsError(f"refused: {c!r} is not a Unicode codepoint")
        clean = {"hex": hx, "count": len(cps)}
        # ROUND10: whether the receipt should carry the resulting screen. Default True, so
        # every existing caller keeps the old 200. `False` is a request for LESS — one
        # `tmux send-keys` and nothing else — so it cannot widen anything: the alphabet,
        # the batch cap, the rate limit and the gate above are all untouched by it. It is
        # normalized to a real bool here for the same reason `read`'s flags are: a
        # 1/"1"/True trio would be three different values for one request downstream.
        clean["echo"] = bool(params.get("echo", True))
    elif verb == "resize":
        # Two integers and a boolean. Nothing here reaches a shell as text: the child
        # formats them back with %d, so the only way a bad value can hurt is by being a
        # *number* that is wrong — which is what the bounds are for.
        try:
            cols, rows = int(params.get("cols")), int(params.get("rows"))
        except (TypeError, ValueError):
            raise KoreOpsError("refused: resize needs integer cols and rows") from None
        lo_c, hi_c = int(pol.get("resize_min_cols", 20)), int(pol.get("resize_max_cols", 400))
        lo_r, hi_r = int(pol.get("resize_min_rows", 5)), int(pol.get("resize_max_rows", 200))
        if not lo_c <= cols <= hi_c:
            raise KoreOpsError(f"refused: cols {cols} outside [{lo_c}, {hi_c}]")
        if not lo_r <= rows <= hi_r:
            raise KoreOpsError(f"refused: rows {rows} outside [{lo_r}, {hi_r}]")
        # `auto` is accepted for compatibility only: _resize_apply now ALWAYS releases the
        # window right after resizing (and never resizes while a real terminal is attached),
        # so no browser geometry outlives the request. It is still a write — it touches an
        # option on somebody else's window — so it keeps the same verb and the same gate.
        clean = {"cols": cols, "rows": rows, "auto": bool(params.get("auto"))}
    elif verb == "read":
        clean = {"lines": max(10, min(600, int(params.get("lines") or 120)))}
        # ROUND8 flags, normalized to real bools here so the cache key cannot be split by
        # 1 vs True vs "1" (three keys for one capture = three round trips a tick).
        if params.get("ansi"):
            clean["ansi"] = True
            clean["screen"] = bool(params.get("screen"))
    return clean


# ------------------------------------------------------------------------ roster

_roster_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_roster_lock = threading.Lock()


def _degraded_roster(scan: str, res: dict[str, Any]) -> dict[str, Any]:
    """A failed probe comes back as data, never as an exception and never as a blank
    panel. Last good answer + `stale` + how old it is, so an operator sees something
    and knows not to trust it; only a cold cache returns empty.

    The stale payload is NOT written back to the cache — its age has to keep growing,
    otherwise a permanently broken cluster would look 0.1s fresh forever.
    """
    with _roster_lock:
        hit = _roster_cache.get(scan)
    base: dict[str, Any]
    if hit:
        base = dict(hit[1])
        base.update(stale=True, stale_age_s=round(time.time() - hit[0], 1))
    else:
        base = {"scan": scan, "sessions": [], "unreachable_nodes": [], "nodes": [],
                "scanned_nodes": [], "session_count": 0, "stale": False,
                "skipped_names": [], "skipped_name_count": 0,
                "fetched_at": time.time()}
    base.update(ok=False, error=res.get("error") or "", probe=res.get("probe") or {})
    return base


def roster(scan: str = "registry", force: bool = False) -> dict[str, Any]:
    """The session list. `scan="cluster"` sweeps every live node, not just registered ones.

    bridge's `kore_list(None)` only visits nodes named in its on-disk registry, so a
    session someone else started elsewhere is invisible. "cluster" fans out over the
    routable nodes in parallel — one dead node then costs one slot's timeout instead
    of stalling the whole sweep. Never raises: a failed sweep must come back as a stated
    reason, not a blank panel.

    The node-touching half runs in a read-agent child (`_roster_raw`), so a crash in there
    costs one child, not the dashboard. Failure returns the last good roster marked
    `stale`.
    """
    scan = "cluster" if scan == "cluster" else "registry"
    pol = policy()
    # A cluster sweep pays a long timeout for every node that is wedged, so it gets its
    # own, much longer TTL — otherwise every click would re-pay it. The registry scan is
    # the cheap one the page polls.
    ttl = float(pol.get("cluster_ttl_s", 120.0) if scan == "cluster"
                else pol.get("roster_ttl_s", 20.0))
    with _roster_lock:
        hit = _roster_cache.get(scan)
        if not force and hit and time.time() - hit[0] < ttl:
            return hit[1]
    res = _read_call("roster-" + scan)
    if not res.get("ok"):
        return _degraded_roster(scan, res)
    raw = res.get("data") or {}
    out: dict[str, Any] = {
        "ok": True, "scan": scan, "stale": False, "error": "",
        "sessions": list(raw.get("sessions") or []),
        "unreachable_nodes": list(raw.get("unreachable_nodes") or []),
        "nodes": list(raw.get("nodes") or []),
        "scanned_nodes": list(raw.get("scanned_nodes") or []),
        # 2026-10-12: rows the child refused to pass on (name not NAME_RE — see
        # _roster_keep). Carried through to the answer so a missing session is a stated
        # fact on the board instead of a silent gap.
        "skipped_names": list(raw.get("skipped_names") or []),
        "skipped_name_count": int(raw.get("skipped_name_count") or 0),
        "probe": res.get("probe") or {},
    }
    protected = set(pol.get("protected_sessions") or [])
    denied = set(pol.get("deny_nodes") or [])
    # The roster answers with the same liveness rule `alive_ips()` gates writes with, so a
    # row that says "writable" and a gate that refuses can never be two answers to one
    # question; `write_block` carries the reason so the UI never has to guess.
    for n in out["nodes"]:
        n["live"], n["reason"], n["liveness_source"] = node_live(n)
    live_by_ip = {str(n.get("node_ip") or ""): (n["live"], n["reason"])
                  for n in out["nodes"]}
    # The three reasons live in write_block_reason() so each branch names the rule that
    # actually fired and can be exercised without a round trip. The protected test compares
    # full_name(), matching _validate(), so the row and the gate agree for a bare name
    # ("work") and the prefixed tmux one ("kore-work").
    me = self_session()
    out["self_session"] = me or ""
    for s in out["sessions"]:
        ip = str(s.get("node_ip") or "")
        nm = full_name(str(s.get("name") or ""))
        s["protected"] = nm in protected
        s["is_self"] = bool(me) and nm == full_name(me)
        live, why = live_by_ip.get(ip, (False, f"{ip} 不在可路由的节点表里"))
        block = write_block_reason(nm, ip, protected, denied, live, why)
        s["writable"] = not block
        s["write_block"] = block
    out["sessions"].sort(key=lambda s: (s.get("node_ip") or "", s.get("name") or ""))
    out["session_count"] = len(out["sessions"])
    out["fetched_at"] = time.time()
    with _roster_lock:
        _roster_cache[scan] = (time.time(), out)
    return out


# -------------------------------------------------------------------- read verbs

_read_cache: dict[tuple, tuple[float, dict[str, Any]]] = {}
_read_cache_mu = threading.Lock()
"""This cache is written by every SSE stream thread, once per ~0.8s tick, and read by
every browser poll, so the lock is load-bearing: unlocked dict mutation across a
connection's worth of threads hitting the same key is not something to leave to luck."""


def _read_cache_put(key: tuple, res: dict[str, Any]) -> None:
    """Store, and keep the cache bounded. `read` keys include `lines`, so a browser that
    walks the lines parameter — or N panes across M nodes — grows the key space without
    limit otherwise. Oldest-first eviction by timestamp: the entries that matter are the
    ones being refreshed every tick."""
    cap = max(8, int(policy().get("read_cache_max", 64) or 64))
    with _read_cache_mu:
        _read_cache[key] = (time.time(), res)
        if len(_read_cache) > cap:
            for k, _v in sorted(_read_cache.items(), key=lambda kv: kv[1][0])[:len(_read_cache) - cap]:
                _read_cache.pop(k, None)


def read_verb(verb: str, node_ip: str, name: str, *, who: str = "unknown",
              max_age: float | None = None, **params: Any) -> dict[str, Any]:
    """`read` / `status`: remote but read-only. Cached briefly so a polling browser
    cannot turn one open pane into a round trip every frame.

    Not written to the audit log: the log exists so every *write* to a remote host is
    accountable, and a dashboard polling a pane every few seconds would bury those
    lines under thousands of harmless captures. `who` is still taken so the caller's
    identity is available if that trade is ever revisited.

    Isolated like roster: the read runs in the resident read agent, so a crash there
    costs one child, not the dashboard. A cache miss costs ~20ms, which is what lets
    `/api/kore/stream` answer in under a second and lets `read_cache_s` sit at 0.5 so the
    SECOND viewer of one pane is cheap without being a tick stale.

    ROUND9: `max_age` 是调用方说出「这一拍我最多能接受多旧的屏」。它**只收紧**不放松 ——
    ttl = min(policy 的 read_cache_s, max_age) —— 所以它不是一个绕过缓存策略的旋钮，
    最坏情况是把自己退化成不吃缓存、每拍真读一次（在常驻 read agent 上约 20ms）。为什么
    需要它：方案 C② 打字时把 SSE 的节奏提到 0.13s，而 read_cache_s=0.5 会让其中四拍原地
    拿回同一张旧屏，高频纠正变成高频重复。**不接 HTTP 查询串**：这个值由服务端自己按
    「这个 pane 刚才有没有人打字」算出来，读者递不进来，否则一个只读接口就成了资源旋钮。
    """
    if verb not in READ_VERBS:
        raise KoreOpsError(f"refused: {verb!r} is not a read verb")
    pol = policy()
    clean = _validate(pol, verb, node_ip, name, params)
    # The ANSI flags are PART OF THE KEY. They were not, for ten minutes, and that bug is
    # worth a comment: `read` and `read --ansi` are two different payloads for one pane,
    # so a key without them hands the `<pre>` fallback a screen full of escape codes (or
    # hands xterm.js a stripped one) depending on who asked first inside the TTL.
    key = (verb, node_ip, name, clean.get("lines"), clean.get("ansi"), clean.get("screen"))
    ttl = float(pol.get("read_cache_s", 0.5))
    if max_age is not None:
        ttl = min(ttl, max(0.0, float(max_age)))
    with _read_cache_mu:
        hit = _read_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    probe = _read_call(verb, {"node_ip": node_ip, "name": name,
                              "lines": clean.get("lines"),
                              "ansi": clean.get("ansi"),
                              "screen": clean.get("screen")})
    if probe.get("ok"):
        res = dict(probe.get("data") or {})
        res["probe"] = probe.get("probe") or {}
    else:
        res = {"ok": False, "error": probe.get("error") or "probe failed",
               "probe": probe.get("probe") or {}}
    res = {**res, "verb": verb, "node_ip": node_ip, "name": full_name(name),
           "fetched_at": time.time()}
    _read_cache_put(key, res)
    return res


# --------------------------------------------------------------------- write jobs

_jobs: dict[str, dict[str, Any]] = {}
_jobs_order: list[str] = []
_jobs_lock = threading.Lock()


def _remember(job: dict[str, Any]) -> None:
    keep = int(policy().get("job_keep", 200))
    with _jobs_lock:
        _jobs[job["id"]] = job
        _jobs_order.append(job["id"])
        while len(_jobs_order) > keep:
            _jobs.pop(_jobs_order.pop(0), None)


def job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


def jobs(limit: int = 30) -> list[dict[str, Any]]:
    with _jobs_lock:
        ids = _jobs_order[-limit:]
        return [dict(_jobs[i]) for i in reversed(ids) if i in _jobs]


def _worker(j: dict[str, Any], clean: dict[str, Any]) -> None:
    j["state"] = "running"
    j["started_at"] = time.time()
    verb, ip, name = j["verb"], j["node_ip"], j["name_arg"]
    try:
        # The write verbs run in the resident agent child, not here. Validation already
        # happened (submit -> _validate); this parent keeps the ledger and the audit
        # trail, and a crash on the far side of the pipe costs one failed job.
        res = _agent_call(verb, ip, name, clean)
        j["result"] = res
        j["ok"] = bool(res.get("ok"))
        j["error"] = "" if j["ok"] else str(res.get("error") or "")
        j["state"] = "done" if j["ok"] else "failed"
    except Exception as exc:  # noqa: BLE001 - a failed job must be visible, not vanish
        j["state"] = "failed"
        j["ok"] = False
        j["error"] = f"{type(exc).__name__}: {exc}"
        j["result"] = {}
    j["finished_at"] = time.time()
    j["elapsed_s"] = round(j["finished_at"] - j["started_at"], 1)
    _audit({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "at_epoch": j["finished_at"],
            "action": "finished", "job_id": j["id"], "verb": verb, "who": j["who"],
            "node_ip": ip, "name": j["name"], "ok": j["ok"], "error": j["error"][:500],
            "elapsed_s": j["elapsed_s"],
            # Re-stamped here, not only on `accepted`: the dashboard joins the two halves
            # of an edge on job_id, and a reader that only ever sees `finished` rows (the
            # audit is tailed, `read_audit(limit)` can cut between the pair) would
            # otherwise see a completed write with no idea which round asked for it.
            **({"origin": j["origin"]} if j.get("origin") else {}),
            **({"origin_invalid": j["origin_invalid"]} if j.get("origin_invalid") else {}),
            "result_state": (j.get("result") or {}).get("state", "")})


def _clean_origin(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """Shape-check the caller's `origin` claim. Returns (origin, invalid_reason).

    R6-DASHBOARD. Contract, in order of importance:

    1. **It can never refuse a write.** A bad origin yields (None, "<reason>") and the
       caller proceeds exactly as if it had sent nothing. If a malformed origin could
       block a write, `origin` would have become a permission input through the back
       door, and every future caller would have to get it right to be allowed to work.
    2. **Bad input is reported, not silently dropped.** The reason lands in the audit as
       `origin_invalid`, so "somebody is stamping junk" is visible instead of looking
       identical to "nobody stamped anything".
    3. **It is bounded.** The audit log is append-only with no delete path, so an
       unbounded caller-supplied field is a disk-growth hole. Three small fields only.
    """
    if raw is None:
        return None, ""
    if not isinstance(raw, dict):
        return None, f"origin must be an object, got {type(raw).__name__}"
    extra = sorted(set(raw) - {"run_id", "round", "task_id"})
    if extra:
        return None, f"origin has unknown keys: {', '.join(extra)}"
    run_id, task_id = str(raw.get("run_id") or ""), str(raw.get("task_id") or "")
    if not ORIGIN_ID_RE.match(run_id):
        return None, f"origin.run_id must match {ORIGIN_ID_RE.pattern}"
    if not ORIGIN_ID_RE.match(task_id):
        return None, f"origin.task_id must match {ORIGIN_ID_RE.pattern}"
    try:
        rnd = int(raw.get("round"))
    except (TypeError, ValueError):
        return None, "origin.round must be an integer"
    if not 1 <= rnd <= 9999:
        return None, f"origin.round {rnd} is outside 1..9999"
    return {"run_id": run_id, "round": rnd, "task_id": task_id}, ""


def submit(verb: str, node_ip: str, name: str, *, who: str = "unknown",
           **params: Any) -> dict[str, Any]:
    """Validate now, run in a background thread, return a job id immediately.

    Nothing here blocks: `kore_send(wait=True)` can take minutes, and an HTTP handler
    that waited for it would freeze the dashboard for every other viewer too.
    """
    pol = policy()
    at = time.time()
    msg = params.get("message")
    # Lifted out of `params` BEFORE validation on purpose: _validate() must not even see
    # it. _validate_params() builds `clean` from scratch per verb, so an extra key would
    # be dropped anyway — but "happens to be ignored" is not the same guarantee as
    # "never reaches the validator", and this is the line that makes it the latter.
    origin, origin_invalid = _clean_origin(params.pop("origin", None))
    base = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(at)),
        "at_epoch": at, "verb": verb, "who": who, "node_ip": node_ip,
        "name": full_name(name) if NAME_RE.match(name or "") else str(name)[:64],
    }
    if origin is not None:
        base["origin"] = origin
    if origin_invalid:
        base["origin_invalid"] = origin_invalid
    if isinstance(msg, str):
        base["message"] = msg
        base["message_sha256"] = hashlib.sha256(msg.encode("utf-8")).hexdigest()
        base["message_bytes"] = len(msg.encode("utf-8"))

    def refuse(reason: str) -> None:
        _audit({**base, "action": "refused", "ok": False, "reason": reason})
        raise KoreOpsError(reason)

    if verb not in WRITE_VERBS:
        refuse(f"refused: {verb!r} is not a write verb. known: {', '.join(WRITE_VERBS)}")
    if verb == "input":
        # One door per verb. `input` IS a write and IS in WRITE_VERBS (that is what makes
        # do_POST and _validate cover it), but its door is `input_keys()`: synchronous, its
        # own minute budget, its own ledger. Letting it through here too would give one
        # verb two gates with two different budgets — and the job-row path is the one that
        # blows `job_keep` at typing speed. Refused loudly rather than quietly allowed.
        refuse("refused: 'input' is synchronous — use koreops.input_keys() / POST "
               "/api/kore/input, not the job queue")
    if verb == "resize":
        # Same rule, same reason (ROUND9). A window drag is not an action worth a job row,
        # and its door is `resize_window()`: synchronous, its own minute budget, its own
        # ledger rows in input.jsonl.
        refuse("refused: 'resize' is synchronous — use koreops.resize_window() / POST "
               "/api/kore/resize, not the job queue")
    try:
        clean = _validate(pol, verb, node_ip, name, params)
    except KoreOpsError as exc:
        refuse(str(exc))
        raise  # unreachable; keeps type checkers honest
    ok, recent = _rate_ok(int(pol.get("max_per_minute", 20)))
    if not ok:
        refuse(f"refused: rate limit — {recent} kore writes in the last 60s")

    j = {**base, "id": f"j{int(at)}-{secrets.token_hex(3)}", "name_arg": name,
         "params": {k: v for k, v in clean.items() if k != "message"},
         "state": "queued", "ok": None, "error": "", "result": {},
         "submitted_at": at, "started_at": None, "finished_at": None}
    _remember(j)
    _audit({**base, "action": "accepted", "job_id": j["id"], "params": j["params"]})
    threading.Thread(target=_worker, args=(j, clean), daemon=True,
                     name=f"koreops-{j['id']}").start()
    return dict(j)


def run_sync(verb: str, node_ip: str, name: str, *, timeout: float = 660.0,
             **kw: Any) -> dict[str, Any]:
    """CLI helper: submit then poll until the job settles."""
    j = submit(verb, node_ip, name, **kw)
    deadline = time.time() + timeout
    while time.time() < deadline:
        cur = job(j["id"])
        if cur and cur["state"] in ("done", "failed"):
            return cur
        time.sleep(0.5)
    return job(j["id"]) or j


# --------------------------------------------------------- ROUND8 terminal input
#
# `input` is the fifth write verb and the only synchronous one. The three things that
# make it a different SHAPE from start/stop/send/keys — and why each is not a loophole:
#
#   1. No job row. `job_keep` is 200 and typing a sentence is ~30 batches, so one row per
#      batch would evict every real write from the jobs panel within a minute of typing.
#      The receipt a keystroke needs is the SCREEN, which comes back in the response.
#   2. Its own minute budget. `max_per_minute: 20` is the right number for "somebody
#      clicked 派活"; it is the wrong number for a keyboard by a factor of thirty.
#   3. Its own ledger file. Accountability is unchanged (every batch is recorded, with
#      who / when / where / how many codepoints / a sha256 of the bytes) but it cannot
#      drown the write audit that `_rate_ok` reads.
#
# What is NOT different: `_validate()`. Same enabled / verbs / IPv4 / deny_nodes /
# NAME_RE / protected_sessions / cluster-membership path as every other write, called
# from the same place, with no `if verb == "input"` shortcut anywhere inside it. And the
# only HTTP door is an authenticated POST — `do_POST` reaches this through
# `verb in WRITE_VERBS`, while `_get_api` has no branch that can call it at all.

_input_hits: list[float] = []
_input_mu = threading.Lock()
# ROUND9: `resize`'s own window. A separate list, not a shared one — a browser being
# dragged must not be able to spend the typing budget, and a fast typist must not be able
# to make the board refuse to fit the terminal.
_resize_hits: list[float] = []


def _input_rate_ok(max_per_minute: int) -> tuple[bool, int]:
    """Keystroke budget, counted in memory over a 60s window.

    Deliberately NOT read from a log file the way `_rate_ok` is: that function re-reads
    400 audit rows on every call, which is fine twenty times a minute and absurd six
    hundred times a minute. The trade is that a board restart forgets the window — which
    for a typing budget is the right way to be wrong (worst case: one extra batch).
    """
    return _window_ok(_input_hits, max_per_minute)


def _resize_rate_ok(max_per_minute: int) -> tuple[bool, int]:
    """Same clock, same 60s window, its own list. See `_resize_hits`."""
    return _window_ok(_resize_hits, max_per_minute)


def _window_ok(hits: list[float], max_per_minute: int) -> tuple[bool, int]:
    now = time.time()
    with _input_mu:
        hits[:] = [t for t in hits if now - t < 60]
        n = len(hits)
        if n >= max_per_minute:
            return False, n
        hits.append(now)
        return True, n


def _audit_input(record: dict[str, Any]) -> dict[str, Any]:
    """Append to the keystroke ledger, rotating at one generation.

    No plaintext: `sha256` + `codepoints` (+ `bytes` on accepted rows, which is what the
    far side's tty actually received after the UTF-8 expansion in `_input_apply` — see
    that function for why the two numbers differ), same discipline the `send` audit uses
    for its message. What somebody typed into a claude-code prompt is content; THAT a
    write happened, to which host, at what time, by whom, is the accountability.
    """
    os.makedirs(AUDIT_DIR, exist_ok=True)
    cap = int(policy().get("input_log_max_bytes", 8388608))
    try:
        if os.path.getsize(INPUT_LOG) > cap:
            os.replace(INPUT_LOG, INPUT_LOG + ".1")
    except OSError:
        pass
    with open(INPUT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def input_keys(node_ip: str, name: str, *, hex_keys: str,
               echo: bool = True, who: str = "unknown") -> dict[str, Any]:
    """One batch of keystrokes, typed now, with the resulting screen as the receipt.

    Synchronous on purpose (see the section comment): the caller is a terminal waiting to
    repaint, not a dashboard waiting for a job id. Everything that can refuse this call
    refuses it BEFORE the write agent is touched, and every refusal is in the ledger.

    `echo=False` asks for the receipt WITHOUT that screen (ROUND10) — for a caller that is
    already watching the same pane as a byte stream. It is written into the ledger row, so
    the ledger still says what happened and under which shape.
    """
    pol = policy()
    at = time.time()
    cps = [c for c in str(hex_keys or "").strip().split(" ") if c]
    base = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(at)),
            "at_epoch": at, "verb": "input", "who": who, "node_ip": node_ip,
            "name": full_name(name) if NAME_RE.match(name or "") else str(name)[:64],
            "codepoints": len(cps), "echo": bool(echo),
            "sha256": hashlib.sha256(" ".join(cps).encode("utf-8")).hexdigest()}

    def refuse(reason: str) -> None:
        _audit_input({**base, "action": "refused", "ok": False, "reason": reason})
        raise KoreOpsError(reason)

    try:
        clean = _validate(pol, "input", node_ip, name, {"hex": hex_keys, "echo": echo})
    except KoreOpsError as exc:
        refuse(str(exc))
        raise  # unreachable; keeps type checkers honest
    ok, recent = _input_rate_ok(int(pol.get("max_input_per_minute", 600)))
    if not ok:
        refuse(f"refused: input rate limit — {recent} keystroke batches in the last 60s")
    res = _agent_call("input", node_ip, name, clean)
    _audit_input({**base, "action": "accepted", "ok": bool(res.get("ok")),
                  "error": str(res.get("error") or "")[:200],
                  "bytes": res.get("sent_bytes"),
                  "agent": (res.get("agent") or {}).get("pid")})
    # ROUND8 阶段2: stamp the receipt with the same clock, in the same process, that
    # read() stamps `fetched_at` with. The browser has two sources for one pane — this
    # echo and the SSE ticks — and it decides which screen is newer by comparing these
    # numbers. Two clocks (or a missing stamp, which makes the comparison silently
    # vacuous) would turn that into a coin flip and let a pre-keystroke tick paint over
    # the screen the keystroke produced. Not stamped in the write agent for the same
    # reason: that is a different process.
    return {**res, "fetched_at": time.time(), "verb": "input",
            "node_ip": node_ip, "name": full_name(name)}


def resize_window(node_ip: str, name: str, *, cols: int, rows: int, auto: bool = False,
                  who: str = "unknown") -> dict[str, Any]:
    """Make the far window `cols`×`rows` now, with the resulting screen as the receipt.

    Same door shape as `input_keys()`: synchronous, no job row, its own minute budget, its
    own ledger rows. Every refusal is written down before the write agent is touched.

    Why this verb exists at all (ROUND9): the browser's terminal must have exactly the far
    side's cols×rows, because the frame protocol repaints by absolute row number. Until now
    the only free variable was the font, so a 131-column session in a narrow window drove
    the font to the 6px floor and still clipped. Pinning the font and resizing the far
    window instead is the chosen fix, and it is a write, so it comes through here.
    """
    pol = policy()
    at = time.time()
    base = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(at)),
            "at_epoch": at, "verb": "resize", "who": who, "node_ip": node_ip,
            "name": full_name(name) if NAME_RE.match(name or "") else str(name)[:64],
            "cols": cols if isinstance(cols, int) else str(cols)[:16],
            "rows": rows if isinstance(rows, int) else str(rows)[:16],
            "auto": bool(auto)}

    def refuse(reason: str) -> None:
        _audit_input({**base, "action": "refused", "ok": False, "reason": reason})
        raise KoreOpsError(reason)

    try:
        clean = _validate(pol, "resize", node_ip, name,
                          {"cols": cols, "rows": rows, "auto": auto})
    except KoreOpsError as exc:
        refuse(str(exc))
        raise  # unreachable; keeps type checkers honest
    ok, recent = _resize_rate_ok(int(pol.get("max_resize_per_minute", 60)))
    if not ok:
        refuse(f"refused: resize rate limit — {recent} resizes in the last 60s")
    res = _agent_call("resize", node_ip, name, clean)
    _audit_input({**base, "action": "accepted", "ok": bool(res.get("ok")),
                  "error": str(res.get("error") or "")[:200],
                  "got": f"{res.get('cols')}x{res.get('rows')}",
                  "agent": (res.get("agent") or {}).get("pid")})
    # Stamped in this process, like input's receipt, because the browser decides which of
    # its two screens is newer by comparing these numbers. See input_keys().
    return {**res, "fetched_at": time.time(), "verb": "resize",
            "node_ip": node_ip, "name": full_name(name)}


# ------------------------------------------------------- ROUND10 tap (byte stream)
#
# Why there is a second read path at all. The `read` verb hands back a *screen*: a
# capture, ~21ms of far-side work, which a client then has to ask for on a tick. Measured
# on this board the tick was the whole lag (1000ms idle / 130ms while typing), and no tick
# is short enough — polling for keystroke echo means paying for a round trip per frame
# whether or not anything happened. This path hands back *bytes*: one resident
# `tmux -C attach -r` on the node, and the bytes it sees arrive here 1.2ms later
# (measured). It is read-only by construction — the control connection is opened with `-r`
# and never written to, so the only way this path can change the far side is not to exist.
# Geometry still goes through the `resize` write door, which is where authority lives.


def _tap_say(kind: str, payload: str = "") -> bool:
    """One line of the stdout protocol. False means the reader is gone.

    The protocol, one event per line, newline-framed so a relay can forward it without
    understanding any of it:
        r <cols>x<rows>   attached; this is the far geometry right now
        o <base64>        a block of bytes for the emulator
        g <cols>x<rows>   the far window changed size (a repaint rides in the next `o`)
        h <epoch>         heartbeat: nothing happened over there, still attached
        e <message>       over — refused, dead session, or the stream was closed
    base64 because this is a byte stream going down a line-framed pipe and then into an
    SSE event, and both of those end at a newline.
    """
    try:
        sys.stdout.write(f"{kind} {payload}\n" if payload else f"{kind}\n")
        sys.stdout.flush()
        return True
    except (BrokenPipeError, ValueError):
        # The reader went away. That is the liveness signal for this whole path: no timer
        # decides when a tap is stale, the pipe does.
        return False


def _tap_sigterm(signum, frame):  # noqa: ARG001 - signal handler signature
    raise KeyboardInterrupt


def tap_stream(node_ip: str, name: str, *, who: str = "unknown") -> int:
    """`koreops.py tap <node_ip> <name>`: own one byte tap, print its bytes, forever.

    Runs in a child so a wedged node can never park the board. It is a READ door —
    `_validate` with the `read` verb, no rate ledger, no job row, nothing written anywhere
    near the far side.
    """
    pol = policy()
    try:
        # SIGTERM is how the board lets go of a tap (the browser closed the pane). Default
        # SIGTERM would kill this process without running the `finally` below, and the far
        # `tmux -C` would then only go away when its owner's death was noticed. Raising
        # instead means the normal shutdown path runs and the remote process is gone now.
        signal.signal(signal.SIGTERM, _tap_sigterm)
    except (ValueError, OSError):
        pass  # not the main thread: the finally still runs on every other exit
    try:
        _validate(pol, "read", node_ip, name, {})
    except KoreOpsError as exc:
        _tap_say("e", str(exc))
        return 2
    sess = full_name(name)
    # Written to the input ledger, NOT log.jsonl, and for the same reason keystrokes are:
    # `_rate_ok()` counts accepted writes inside the last 400 rows of log.jsonl, so rows
    # that are not writes would widen that window and make the write rate limit looser the
    # more panes somebody watches. A tap is a read; it has no business in the write ledger.
    _audit_input({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "at_epoch": time.time(),
                  "verb": "tap", "who": who, "node_ip": node_ip, "name": sess,
                  "action": "attach", "ok": True})
    # Everything above here is node-agnostic (refusal gate + audit). The tail routes PER
    # NODE exactly as the engine's `sh()` does — the server's own node taps in-process,
    # any other node taps through its agent over HTTP — and both re-emit the IDENTICAL
    # r/o/g/h/e protocol, so tap_spawn, server.py's _sse_bytes/_tap_relay and index.html
    # never learn which backend produced the bytes.
    br = bridge()
    if node_ip == br._local_node_ip():
        return _tap_local(br, node_ip, sess, pol)
    return _tap_http(br, node_ip, sess, pol)


def _tap_http(br: Any, node_ip: str, sess: str, pol: dict[str, Any]) -> int:
    """HTTP backend: the node's kore-agent holds the `tmux -C` and streams the r/o/g/h/e
    protocol as chunked text; this just forwards each line to `_tap_say` verbatim (the
    agent emits the identical vocabulary). Teardown is the three-layer story from the
    plan: SIGTERM here -> `finally` closes the response (TCP FIN) -> the agent's next
    write BrokenPipes and it closes its pane; and if the agent goes silent, the socket
    read-timeout (3x heartbeat) ends us with an `e` rather than hanging."""
    import socket as _socket  # noqa: PLC0415

    try:
        url = br.resolve_agent_url(node_ip)
    except Exception as exc:  # noqa: BLE001 - unknown/stale node is a stated reason
        _tap_say("e", f"找不到 {node_ip} 的 kore-agent：{exc}")
        return 2
    query = {"session": sess,
             "hist": int(pol.get("tap_hist_lines", 400)),
             "max_bytes": int(pol.get("tap_chunk_max_bytes", 262144))}
    read_timeout = max(6.0, float(pol.get("tap_pull_wait_s", 2.0)) * 3)
    try:
        resp = br._agent_stream(url, "/tap", query, timeout=read_timeout)
    except Exception as exc:  # noqa: BLE001
        _tap_say("e", f"连 {url} 的 /tap 没连上：{type(exc).__name__}: {exc}")
        return 2
    try:
        for raw in resp:
            line = raw.rstrip(b"\r\n")
            if not line:
                continue
            kind, _, payload = line.partition(b" ")
            k = kind.decode("ascii", "replace")
            p = payload.decode("utf-8", "replace")
            if k == "e":
                _tap_say("e", p)
                return 0
            if not _tap_say(k, p):  # the reader went away — stop, `finally` closes the TCP
                return 0
        _tap_say("e", "agent 的 /tap 流到头了（对面 detach 或 agent 退了）")
        return 0
    except _socket.timeout:
        _tap_say("e", f"agent 静默超时（{read_timeout:.0f}s 内没有任何帧，含心跳），tap 收了")
        return 0
    except KeyboardInterrupt:
        _tap_say("e", "收到停手信号（Ctrl-C 或者板子撤了），tap 收了")
        return 0
    except Exception as exc:  # noqa: BLE001 - a mid-stream cut on teardown is normal
        _tap_say("e", f"tap 流断了：{type(exc).__name__}: {exc}")
        return 0
    finally:
        try:
            resp.close()  # TCP FIN -> the agent's next write BrokenPipes -> pane.close()
        except Exception:  # noqa: BLE001
            pass


def _tap_local(br: Any, node_ip: str, sess: str, pol: dict[str, Any]) -> int:
    """Self-node backend: run PaneTap in THIS process (kore-agent's authoritative copy),
    re-emitting via `_tap_say` exactly as the HTTP relay does. No agent, no round trip."""
    PaneTap = agent_mod().PaneTap
    wait = float(pol.get("tap_pull_wait_s", 2.0))
    pane = PaneTap(sess, int(pol.get("tap_hist_lines", 400)),
                   int(pol.get("tap_chunk_max_bytes", 262144)))
    try:
        res = pane.start()
        if not res.get("ok"):
            _tap_say("e", str(res.get("error") or "attach 失败，没说为什么"))
            return 2
        if not _tap_say("r", f"{res['cols']}x{res['rows']}"):
            return 0
        if res.get("paint") and not _tap_say(
                "o", base64.b64encode(res["paint"]).decode("ascii")):
            return 0
        while True:
            got = pane.pull(wait)
            if got.get("geom") and not _tap_say("g", got["geom"]):
                return 0
            data = got.get("bytes") or b""
            if got.get("dropped"):
                print(f"[tap] 丢了 {got['dropped']}B 积压（超过 tap_chunk_max_bytes），"
                      f"已整屏重画", file=sys.stderr, flush=True)
            if data:
                if not _tap_say("o", base64.b64encode(data).decode("ascii")):
                    return 0
            elif not got.get("dead") and not _tap_say("h", f"{time.time():.3f}"):
                return 0
            if got.get("dead"):
                _tap_say("e", str(got["dead"]))
                return 0
    except KeyboardInterrupt:
        _tap_say("e", "收到停手信号（Ctrl-C 或者板子撤了），tap 收了")
        return 0
    except Exception as exc:  # noqa: BLE001
        _tap_say("e", f"{type(exc).__name__}: {exc}")
        return 2
    finally:
        try:
            pane.close()  # kills the local `tmux -C attach -r`
        except Exception:  # noqa: BLE001
            pass


def tap_spawn(node_ip: str, name: str, *, who: str = "unknown") -> subprocess.Popen:
    """Start a `tap` child for somebody else to read, and hand back the process.

    Here rather than in the caller so the board does not grow its own idea of how to
    launch a koreops child: same interpreter (`_probe_python()`) and same environment
    (`_child_env()`) as the read and write agents, chosen in one place.

    argv list, never a shell string — and `node_ip`/`name` are validated *inside* the
    child, so a bad one is a line on stdout rather than something that reached a shell.
    Refusals are not raised from here on purpose: the child prints `e <reason>` and exits
    2, which is also how a dead session and a lost agent connection report, so a relay has
    exactly one place to look.

    stderr is inherited, not piped: it carries the child's own notes (e.g. dropped-backlog)
    and an unread pipe would eventually block the child mid-stream.
    """
    cmd = [_probe_python(), os.path.abspath(__file__), "tap", node_ip, name,
           "--who", who or "unknown"]
    return subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            env=_child_env())


# --------------------------------------------------------------------------- CLI


def _cli_who() -> str:
    try:
        return f"cli:{getpass.getuser()}@{os.uname().nodename}"
    except Exception:  # noqa: BLE001
        return "cli:unknown"


def _dump(obj: Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="koreops.py", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("policy", help="show the effective kore policy")

    # The write-gate's own answer, printable. An in-process predicate nobody can query is
    # a predicate nobody can test — this is the check made observable.
    sub.add_parser("alive", help="which nodes may be written to, and why (read-only)")

    pr = sub.add_parser("roster", help="list kore sessions")
    pr.add_argument("--cluster", action="store_true", help="sweep every live node")
    pr.add_argument("--force", action="store_true")

    def target(sp: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sp.add_argument("node_ip")
        sp.add_argument("name")
        return sp

    def origin_flags(sp: argparse.ArgumentParser) -> argparse.ArgumentParser:
        """R6-DASHBOARD: let a caller stamp WHY this write happened (audit only).

        Write verbs only — a read leaves no edge to attribute. All three must be given
        together or the stamp is dropped with a reason in the audit; see _clean_origin.
        """
        sp.add_argument("--origin-run", default="", metavar="RUN_ID",
                        help="loop run_id this write belongs to (recorded, never checked)")
        sp.add_argument("--origin-round", default="", metavar="N",
                        help="loop round number (recorded, never checked)")
        sp.add_argument("--origin-task", default="", metavar="TASK_ID",
                        help="task id within the round (recorded, never checked)")
        return sp

    prd = target(sub.add_parser("read", help="capture the pane (read-only)"))
    prd.add_argument("--lines", type=int, default=120)
    prd.add_argument("--ansi", action="store_true",
                     help="keep the ANSI escape codes (capture-pane -e) + geometry/cursor")
    prd.add_argument("--screen", action="store_true",
                     help="with --ansi: the visible screen only, no scrollback")
    target(sub.add_parser("status", help="tmux/claude liveness (read-only)"))

    pst = origin_flags(target(sub.add_parser("start", help="start a kore session")))
    pst.add_argument("--cwd", required=True)
    pst.add_argument("--role", default="")

    psn = origin_flags(target(sub.add_parser("send", help="send one line of work")))
    psn.add_argument("--message", "-m", required=True)
    psn.add_argument("--no-wait", action="store_true")

    pk = origin_flags(target(sub.add_parser("keys", help="send one allowlisted key")))
    pk.add_argument("--key", required=True)

    # ROUND8: the terminal input path, by hand. `--hex 1b 5b 41` is Up; `--hex 03` is
    # Ctrl-C; `--hex 68 69 0d` types "hi" and Enter. No origin flags: this verb does not
    # go through submit() and has no job row for an origin stamp to hang off.
    pin = target(sub.add_parser("input", help="type hex codepoints into the pane"))
    pin.add_argument("--hex", required=True, metavar="'1b 5b 41'",
                     help="space-separated lowercase hex codepoints")
    # ROUND10：不要回执里那一屏。给「已经在用 `tap` 看同一个 pane」的调用方用 —— 省掉
    # settle + capture（真板子实测 140ms → ~20ms）。默认仍然带屏。
    pin.add_argument("--no-echo", dest="echo", action="store_false", default=True,
                     help="don't capture the resulting screen into the receipt")

    # The window-geometry path, by hand. The window is always handed back to tmux right
    # after resizing, and left alone while a real terminal is attached. `--auto` is kept for
    # compatibility. No origin flags, same reason as `input`.
    prz = target(sub.add_parser("resize", help="resize the far tmux window"))
    prz.add_argument("--cols", type=int, required=True)
    prz.add_argument("--rows", type=int, required=True)
    prz.add_argument("--auto", action="store_true",
                     help="compatibility no-op (the window is always released after resizing)")

    origin_flags(target(sub.add_parser("stop", help="kill the tmux session")))

    # ROUND10: the byte stream, by hand. Not in READ_VERBS — `read`/`status` answer once
    # with a dict, and this one answers in lines until somebody stops reading. It prints
    # the `r`/`o`/`g`/`h`/`e` protocol on stdout and nothing else, which is what makes it
    # usable both as the server's child and as a diagnostic you can eyeball:
    #     python3 koreops.py tap 10.0.0.9 work | head -3
    ptp = target(sub.add_parser("tap", help="stream the pane's bytes (control mode, read-only)"))
    ptp.add_argument("--who", default="",
                     help="who is watching, for the ledger row (the board passes its user)")

    pj = sub.add_parser("jobs", help="recent write jobs (this process only)")
    pj.add_argument("--limit", type=int, default=30)
    pl = sub.add_parser("log", help="tail the audit log")
    pl.add_argument("--limit", type=int, default=20)

    # Internal: the one-shot child, kept as a hand-run diagnostic (it shares
    # `_read_dispatch()` with the resident read agent, so it cannot drift from it).
    # Not the serving path — the resident read agent is.
    pp = sub.add_parser("probe", help="internal: run one read in a throwaway child")
    pp.add_argument("--kind", required=True, choices=list(_PROBE_KINDS))
    pp.add_argument("--args", default="")

    # Internal: the resident halves of the isolation. Same reasoning as `probe` — the
    # mechanism is a documented verb, not a hidden env-var branch. Both read JSON
    # requests on stdin, answer sentinel-prefixed lines on stdout, and exit at EOF.
    sub.add_parser("write-agent", help="internal: resident write agent (stdin/stdout JSON)")
    sub.add_parser("read-agent", help="internal: resident read agent (stdin/stdout JSON)")

    args = p.parse_args(argv)
    try:
        if args.cmd == "probe":
            # No _dump() here: stdout carries exactly one sentinel line.
            return _probe_child(args.kind, json.loads(args.args) if args.args else {})
        if args.cmd == "write-agent":
            return _write_agent_child()
        if args.cmd == "read-agent":
            return _read_agent_child()
        if args.cmd == "policy":
            _dump({"ok": True, "allowlist": ALLOWLIST, "policy": policy()})
            return 0
        if args.cmd == "alive":
            _dump(node_liveness(force=True))
            return 0
        if args.cmd == "roster":
            _dump(roster("cluster" if args.cluster else "registry", force=args.force))
            return 0
        if args.cmd in READ_VERBS:
            kw = ({"lines": args.lines, "ansi": args.ansi, "screen": args.screen}
                  if args.cmd == "read" else {})
            res = read_verb(args.cmd, args.node_ip, args.name, who=_cli_who(), **kw)
            _dump(res)
            return 0 if res.get("ok") else 2
        if args.cmd == "tap":
            # No _dump(): stdout is the line protocol, and a JSON blob on it would be a
            # frame the reader cannot parse.
            return tap_stream(args.node_ip, args.name, who=args.who or _cli_who())
        if args.cmd == "input":
            # Not run_sync(): submit() refuses this verb on purpose (one door per verb).
            res = input_keys(args.node_ip, args.name, hex_keys=args.hex,
                             echo=args.echo, who=_cli_who())
            _dump(res)
            return 0 if res.get("ok") else 2
        if args.cmd == "resize":
            # Same: submit() refuses `resize` too, for the same one-door-per-verb reason.
            res = resize_window(args.node_ip, args.name, cols=args.cols, rows=args.rows,
                                auto=args.auto, who=_cli_who())
            _dump(res)
            return 0 if res.get("ok") else 2
        if args.cmd == "jobs":
            _dump(jobs(args.limit))
            return 0
        if args.cmd == "log":
            for r in read_audit(args.limit):
                print(json.dumps(r, ensure_ascii=False))
            return 0

        kw: dict[str, Any] = {}
        if args.cmd == "start":
            kw = {"cwd": args.cwd, "role": args.role}
        elif args.cmd == "send":
            kw = {"message": args.message, "wait": not args.no_wait}
        elif args.cmd == "keys":
            kw = {"key": args.key}
        # Only pass `origin` through when the caller actually asked for one. Sending
        # {"run_id": "", ...} would make every un-stamped CLI write log an
        # `origin_invalid` reason, which is noise, and noise gets ignored.
        if any((args.origin_run, args.origin_round, args.origin_task)):
            kw["origin"] = {"run_id": args.origin_run, "round": args.origin_round,
                            "task_id": args.origin_task}
        res = run_sync(args.cmd, args.node_ip, args.name, who=_cli_who(), **kw)
        _dump(res)
        return 0 if res.get("ok") else 2
    except KoreOpsError as exc:
        print(json.dumps({"ok": False, "refused": str(exc)}, ensure_ascii=False, indent=2),
              file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
