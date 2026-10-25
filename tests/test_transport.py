#!/usr/bin/env python3
"""Routing tests for the server/client engine.

There is no transport switch: `sh(node_ip)` routes PER NODE — the server's own host runs
locally, every other node is reached over HTTP against its client agent. These cover the
seams a unit test can reach without a second machine or a live agent:

  * `_child_env()` (koreops) propagates KORE_AGENT* / node identity to the spawned children,
    so a tap/read/write child reaches nodes the same way its parent does;
  * the client-agent registry readers (`agents_load` / `agents_prune` / `resolve_agent_url`
    / `agents_live`) do the TTL math and the unknown/stale-node errors right, and
    `agents_live` is "self + fresh clients";
  * `sh()` routes self → local subprocess (incl. the 124 timeout), and a non-self node →
    the HTTP path, which refuses cleanly when no agent is registered for it.

Run: `python3 test_transport.py`  (stdlib only; no network, no agent, no second machine).
"""

import importlib.util
import json
import os
import tempfile
import time

# The engine/agent sources live in the package dir (src/kore/); this test file sits in
# tests/. Point HERE at the package so the hyphenated files load by path as before.
HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")


def _load(name, path, env):
    """Import a (possibly hyphenated) module with `env` applied first — the engine reads
    its node identity at import time, so it must be set before exec_module."""
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_child_env_propagates():
    env = {"KORE_AGENT_TOKEN": "s3cret",
           "KORE_AGENTS_FILE": "/tmp/whatever/agents.json", "KORE_NODE_IP": "10.9.9.9"}
    koreops = _load("t_koreops", os.path.join(HERE, "koreops.py"), env)
    ce = koreops._child_env()
    for k, v in env.items():
        assert ce.get(k) == v, f"_child_env dropped {k}: {ce.get(k)!r} != {v!r}"
    print("ok  _child_env propagates KORE_AGENT* / node identity to children")


def test_registry_readers():
    now = time.time()
    with tempfile.TemporaryDirectory() as d:
        reg = os.path.join(d, "agents.json")
        with open(reg, "w") as f:
            json.dump({
                "10.0.0.1": {"agent_url": "http://10.0.0.1:5000", "last_seen": now,
                             "sessions": ["kore-work"]},
                "10.0.0.2": {"agent_url": "http://10.0.0.2:5000",
                             "last_seen": now - 9999, "sessions": []},
                "garbage": {"agent_url": "http://x", "last_seen": now},  # not an IP
            }, f)
        eng = _load("t_eng_http", os.path.join(HERE, "kore-bridge.py"),
                    {"KORE_AGENTS_FILE": reg, "KORE_AGENT_TTL": "45",
                     "KORE_NODE_IP": "10.5.5.5"})

        assert set(eng.agents_load()) == {"10.0.0.1", "10.0.0.2", "garbage"}, \
            "agents_load should be tolerant and return every key verbatim"
        pruned = eng.agents_prune()
        assert "10.0.0.1" in pruned and "10.0.0.2" not in pruned, \
            f"agents_prune kept the stale node: {sorted(pruned)}"
        assert eng.resolve_agent_url("10.0.0.1") == "http://10.0.0.1:5000"
        for bad in ("10.0.0.2", "10.0.0.9"):  # stale, unknown
            try:
                eng.resolve_agent_url(bad)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"resolve_agent_url({bad}) should have raised")
        # self (KORE_NODE_IP) first, then fresh clients; stale + non-IP dropped.
        assert eng.agents_live() == ["10.5.5.5", "10.0.0.1"], \
            f"agents_live should be self + fresh dotted-quad clients: {eng.agents_live()}"
    print("ok  registry readers: tolerant load, TTL prune, resolve/live, self + fresh only")


def test_routing():
    eng = _load("t_eng_route", os.path.join(HERE, "kore-bridge.py"),
                {"KORE_NODE_IP": "10.7.7.7",
                 "KORE_AGENTS_FILE": "/tmp/does-not-exist/agents.json"})

    # self node -> run locally with subprocess
    r = eng.sh("10.7.7.7", "printf hi", timeout=10)
    assert r == {"stdout": "hi", "stderr": "", "rc": 0}, f"self sh contract broke: {r}"
    t = eng.sh("10.7.7.7", "sleep 5", timeout=1)
    assert t["rc"] == 124, f"self sh should return 124 on timeout, got {t['rc']}"

    # the server's own node is always routable and writable (alive, empty status)
    jm = eng.job_map()
    assert "10.7.7.7" in jm, f"job_map missing the self node: {sorted(jm)}"
    row = jm["10.7.7.7"]
    assert row["status"] == "" and row["alive"] is True, \
        f"self node must be empty-status + alive (keeps it writable): {row}"
    assert eng.alive_ips() == ["10.7.7.7"], f"alive_ips (self only): {eng.alive_ips()}"

    # a non-self node routes to HTTP; with no agent registered it refuses cleanly
    try:
        eng.sh("10.8.8.8", "printf hi", timeout=5)
    except RuntimeError:
        pass
    else:
        raise AssertionError("sh(non-self) with no registered agent should have raised")
    print("ok  routing: self -> local (incl. 124 timeout), non-self -> http refuses cleanly")


def test_dashboard_version():
    """The dashboard runs server.py as a SCRIPT, where the `kore` package is usually not
    importable; the titlebar once showed `v?` because of that. Run server.py's own version
    reader (extracted by AST, so the server is not started) and compare with __init__.py."""
    import ast
    import re
    import sys
    src = open(os.path.join(HERE, "workbench", "server.py"), encoding="utf-8").read()
    fn = next(n for n in ast.parse(src).body
              if isinstance(n, ast.FunctionDef) and n.name == "_read_version")
    ns = {"os": os, "re": re, "HERE": os.path.join(HERE, "workbench")}
    saved = sys.path[:]
    sys.path[:] = [p for p in sys.path if not os.path.isdir(os.path.join(p, "kore"))]
    try:
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "server.py", "exec"), ns)
        got = ns["_read_version"]()
    finally:
        sys.path[:] = saved
    want = re.search(r'__version__\s*=\s*"([^"]+)"',
                     open(os.path.join(HERE, "__init__.py"), encoding="utf-8").read()).group(1)
    assert got == want, f"dashboard version {got!r} != package version {want!r}"
    print(f"ok  dashboard reads its version without importing the package ({got})")


def test_has_session_exact_match():
    """has_session must target tmux with `=` (EXACT), not a bare name (PREFIX). A bare
    `tmux has-session -t kore-test` matches an existing `kore-test-hook`, so `start` falsely
    reports "already exists" and `send`/`stop` would act on the WRONG session (2026-10-25)."""
    import ast
    src = open(os.path.join(HERE, "kore-bridge.py"), encoding="utf-8").read()
    fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "has_session")
    body = ast.get_source_segment(src, fn) or ""
    assert "has-session -t =" in body, "has_session must use an exact `-t =<name>` target"
    assert "has-session -t {name}" not in body, "has_session must not use a bare (prefix) target"
    print("ok  has_session uses tmux exact-match target")


if __name__ == "__main__":
    test_child_env_propagates()
    test_registry_readers()
    test_routing()
    test_dashboard_version()
    test_has_session_exact_match()
    print("\nall routing tests passed")
