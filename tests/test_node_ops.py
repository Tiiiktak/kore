#!/usr/bin/env python3
"""Tests for the node-lifecycle ops (restart / upgrade) and the latest-release check.

These cover the seams a unit test can reach without a second machine or a live agent:
  * `koreops.node_action()` — the policy toggle + action allowlist gate, that it dispatches
    through the bridge, and that a dropped connection (the agent replaces itself mid-call)
    is treated as 'dispatched', not a failure;
  * the server's `_node_action_cmd()` FIXED command builder — detached via setsid, the right
    inner command per target/action, a semver `--version`, and no client command when the
    board holds no agent token (AST-extracted so the server is never started);
  * the semver comparison behind `/api/kore/latest`'s `outdated` flag (cli helpers).

Run: `python3 -m pytest -q tests/test_node_ops.py`  (stdlib only; no network, no agent).
"""

import ast
import importlib.util
import os
import shlex

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")


def _load(name, path, env=None):
    if env:
        os.environ.update(env)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeBridge:
    def __init__(self, raise_on_sh=False):
        self.calls = []
        self.raise_on_sh = raise_on_sh

    def sh(self, node_ip, cmd, timeout=30):
        self.calls.append((node_ip, cmd, timeout))
        if self.raise_on_sh:
            raise RuntimeError("agent connection dropped")  # restart replaced the agent
        return {"stdout": "done", "stderr": "", "rc": 0}


def test_node_action_gate_and_dispatch():
    koreops = _load("t_koreops_node", os.path.join(HERE, "koreops.py"),
                    {"KORE_NODE_IP": "10.1.1.1"})
    koreops._audit = lambda rec: rec            # don't touch the real audit log in a test
    koreops._read_node_gate = lambda ip: None   # IP routability is covered elsewhere
    fake = _FakeBridge()
    koreops.use_bridge(fake)

    # an action outside the allowlist is refused, no dispatch
    for bad in ("frobnicate", "halt", ""):
        try:
            koreops.node_action(bad, "10.2.2.2", "echo x")
        except koreops.KoreOpsError:
            pass
        else:
            raise AssertionError(f"node_action({bad!r}) should have been refused")
    assert not fake.calls, "a refused action must never reach the bridge"

    # an allowed action dispatches the exact command through the bridge
    res = koreops.node_action("restart", "10.2.2.2", "setsid sh -c 'x' &", timeout=20)
    assert res["ok"] and res["dispatched"] and res["action"] == "restart"
    assert fake.calls == [("10.2.2.2", "setsid sh -c 'x' &", 20)], fake.calls

    # a dropped connection (the agent replaced itself) is still 'dispatched', not a failure
    koreops.use_bridge(_FakeBridge(raise_on_sh=True))
    res = koreops.node_action("upgrade", "10.2.2.2", "setsid sh -c 'y' &")
    assert res["ok"] and res["dispatched"] and res["note"], res
    print("ok  node_action: allowlist gate, dispatch, dropped-connection is success")


def test_node_action_disabled_by_policy():
    koreops = _load("t_koreops_node_off", os.path.join(HERE, "koreops.py"),
                    {"KORE_NODE_IP": "10.1.1.1"})
    koreops._audit = lambda rec: rec
    koreops._read_node_gate = lambda ip: None
    koreops.use_bridge(_FakeBridge())
    koreops.policy = lambda: {"node_actions": {"enabled": False,
                                               "actions": {"restart": True, "upgrade": True}}}
    try:
        koreops.node_action("restart", "10.2.2.2", "echo x")
    except koreops.KoreOpsError:
        print("ok  node_action: node_actions.enabled=false refuses everything")
    else:
        raise AssertionError("disabled node_actions must refuse")


def _cmd_builder(token="TOK", proxy=""):
    """AST-extract server.py's `_node_action_cmd` and bind the module globals it needs, so the
    command builder can be exercised without importing (and side-effecting) the whole server."""
    src = open(os.path.join(HERE, "workbench", "server.py"), encoding="utf-8").read()
    cls = next(n for n in ast.parse(src).body
               if isinstance(n, ast.ClassDef) and any(
                   isinstance(m, ast.FunctionDef) and m.name == "_node_action_cmd"
                   for m in n.body))
    fn = next(m for m in cls.body
              if isinstance(m, ast.FunctionDef) and m.name == "_node_action_cmd")
    ns = {"PORT": 8198, "KORE_AGENT_TOKEN": token, "shlex": shlex,
          "_proxy_cmd_prefix": lambda: proxy}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "server.py", "exec"), ns)
    return ns["_node_action_cmd"]


def test_node_action_cmd_shape():
    build = _cmd_builder(token="TOK")

    server_restart = build(None, "server", "restart", "9.9.9.9", "")
    assert server_restart.startswith("setsid sh -c ") and server_restart.rstrip().endswith("&")
    assert "kore server --restart" in server_restart and "--token" not in server_restart

    server_up = build(None, "server", "upgrade", "9.9.9.9", "")
    assert "kore upgrade && kore server --restart" in server_up

    client_restart = build(None, "node", "restart", "9.9.9.9", "")
    assert "kore client --server 9.9.9.9:8198 --token TOK" in client_restart
    assert client_restart.startswith("setsid sh -c ")

    client_up = build(None, "node", "upgrade", "9.9.9.9", "v1.2.3")
    assert "kore upgrade --version v1.2.3 && kore client --server 9.9.9.9:8198 --token TOK" in client_up

    # no agent token on this board -> no client rejoin command can be built
    assert _cmd_builder(token="")(None, "node", "restart", "9.9.9.9", "") == ""

    # a configured proxy rides ONLY the upgrade step, never the restart/rejoin
    up = _cmd_builder(proxy="PX ")(None, "server", "upgrade", "9.9.9.9", "")
    assert "PX kore upgrade && kore server --restart" in up
    rs = _cmd_builder(proxy="PX ")(None, "server", "restart", "9.9.9.9", "")
    assert "PX " not in rs
    print("ok  _node_action_cmd: setsid-detached, right inner command, token/proxy only server-side")


def test_node_system_metrics_parse():
    eng = _load("t_eng_sys", os.path.join(HERE, "kore-bridge.py"),
                {"KORE_NODE_IP": "10.1.1.1", "KORE_AGENTS_FILE": "/tmp/none/agents.json"})
    fake = "\n".join(["LOAD 1.50 2.00 3.00 2/100 1234", "CPUS 8",
                      "MEM 16000000 4000000", "DISK 5000000 10000000",
                      "GPU_START", "0, 100, 40960", "55, 2000, 40960", "GPU_END"])
    eng.sh = lambda ip, cmd, t=15: {"stdout": fake, "stderr": "", "rc": 0}
    m = eng.node_system_metrics("10.2.2.2")
    assert (m["load1"], m["load5"], m["load15"]) == (1.5, 2.0, 3.0)
    assert m["cpus"] == 8
    assert m["mem_total_kb"] == 16000000 and m["mem_avail_kb"] == 4000000
    assert m["disk_used_kb"] == 5000000 and m["disk_total_kb"] == 10000000
    assert len(m["gpus"]) == 2 and m["gpus"][1] == {"util": 55, "mem_used": 2000, "mem_total": 40960}

    def boom(*a, **k):
        raise RuntimeError("node down")
    eng.sh = boom
    assert eng.node_system_metrics("10.2.2.2") == {}, "an unreachable node yields {}, not an error"
    print("ok  node_system_metrics: parse load/cpu/mem/disk/gpu; unreachable -> {}")


def test_latest_outdated_semver():
    cli = _load("t_cli_latest", os.path.join(HERE, "cli.py"))
    assert cli._is_semver("v0.5.3") and cli._is_semver("0.5.3")
    assert not cli._is_semver("nightly")
    assert cli._vtuple("v0.5.10") > cli._vtuple("v0.5.9"), "numeric, not lexical, compare"
    assert cli._vtuple("v0.6.0") > cli._vtuple("v0.5.99")
    assert not (cli._vtuple("v0.5.3") > cli._vtuple("v0.5.3"))
    print("ok  latest outdated: semver parse + numeric compare")
