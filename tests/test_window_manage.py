#!/usr/bin/env python3
"""Tests for the tmux window/pane management verb (`manage`, approach A) and its targeting.

Covers the seams a unit test can reach without a live tmux/agent:
  * `koreops._validate_params("manage", …)` — the action allowlist, required window/pane per
    action, and the window-name charset gate (shell-injection names are refused, not escaped);
  * `koreops._window_arg` / `_pane_arg` / `_tgt` — index validation + shell-safe target strings;
  * `bridge.tmux_manage(...)` — the EXACT tmux command built per action, that indices go in as
    ints and a bad window name never reaches the shell.

Run: `python3 -m pytest -q tests/test_window_manage.py`  (stdlib only; no network, no agent).
"""

import importlib.util
import os

import pytest

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _ko():
    return _load("t_koreops_manage", os.path.join(HERE, "koreops.py"))


# --------------------------------------------------------------- _validate_params("manage")

def test_manage_validate_good():
    ko = _ko()
    c = ko._validate_params({}, "manage", {"action": "rename-window", "window": 2, "title": "build"})
    assert c == {"action": "rename-window", "window": 2, "title": "build"}
    c = ko._validate_params({}, "manage", {"action": "split-window", "window": 1, "dir": "v"})
    assert c == {"action": "split-window", "window": 1, "dir": "v"}
    c = ko._validate_params({}, "manage", {"action": "new-window"})
    assert c == {"action": "new-window"}
    c = ko._validate_params({}, "manage", {"action": "kill-pane", "window": 0, "pane": 3})
    assert c == {"action": "kill-pane", "window": 0, "pane": 3}
    # window-scoped actions may omit the window (tmux targets the active window)
    assert ko._validate_params({}, "manage", {"action": "kill-window"}) == {"action": "kill-window"}
    assert ko._validate_params({}, "manage", {"action": "resize-pane", "window": 0, "pane": 1, "cols": 90}) == {
        "action": "resize-pane", "window": 0, "pane": 1, "cols": 90}


def test_manage_validate_refusals():
    ko = _ko()
    bad = [
        {"action": "evil"},                                   # not allowlisted
        {"action": ""},                                       # empty
        {"action": "kill-pane", "window": 0},                 # needs a pane
        {"action": "resize-pane", "window": 0, "pane": 1},    # needs cols/rows
        {"action": "rename-window", "window": 0, "title": "a;rm -rf /"},   # shell metachars
        {"action": "rename-window", "window": 0, "title": "x`id`"},        # backtick
        {"action": "rename-window", "window": 0, "title": ""},             # empty name
        {"action": "rename-window", "window": 0, "title": "'; tmux kill-server #"},
    ]
    for p in bad:
        with pytest.raises(ko.KoreOpsError):
            ko._validate_params({}, "manage", p)


def test_window_pane_arg_range_and_target():
    ko = _ko()
    assert ko._window_arg({"window": 0}) == 0
    assert ko._window_arg({"window": "7"}) == 7
    assert ko._window_arg({}) is None
    for bad in ({"window": -1}, {"window": 1000}, {"window": "x"}):
        with pytest.raises(ko.KoreOpsError):
            ko._window_arg(bad)
    # target string is session[:win[.pane]] — never folds anything unvalidated into the name
    assert ko._tgt("kore-x", None, None) == "kore-x"
    assert ko._tgt("kore-x", 2, None) == "kore-x:2"
    assert ko._tgt("kore-x", 2, 1) == "kore-x:2.1"


# --------------------------------------------------------------- bridge.tmux_manage commands

class _FakeSh:
    def __init__(self):
        self.cmd = None

    def __call__(self, ip, cmd, timeout=20):
        self.cmd = cmd
        return {"stdout": "", "stderr": "", "rc": 0}


def _bridge_with_fake_sh():
    br = _load("t_bridge_manage", os.path.join(HERE, "kore-bridge.py"))
    fake = _FakeSh()
    br.sh = fake
    return br, fake


def test_tmux_manage_builds_exact_commands():
    br, fake = _bridge_with_fake_sh()
    ip = "10.0.0.1"

    br.tmux_manage(ip, "work", "rename-window", window=2, title="build")
    assert fake.cmd == "tmux rename-window -t kore-work:2 'build' 2>&1", fake.cmd

    br.tmux_manage(ip, "work", "new-window", title="extra")
    assert fake.cmd == "tmux new-window -t kore-work -n 'extra' 2>&1", fake.cmd

    br.tmux_manage(ip, "work", "kill-window", window=1)
    assert fake.cmd == "tmux kill-window -t kore-work:1 2>&1", fake.cmd

    br.tmux_manage(ip, "work", "split-window", window=0, pane=1, direction="v")
    assert fake.cmd == "tmux split-window -v -t kore-work:0.1 2>&1", fake.cmd

    br.tmux_manage(ip, "work", "kill-pane", window=0, pane=2)
    assert fake.cmd == "tmux kill-pane -t kore-work:0.2 2>&1", fake.cmd


def test_tmux_manage_rejects_bad_name_before_shell():
    br, fake = _bridge_with_fake_sh()
    r = br.tmux_manage("10.0.0.1", "work", "rename-window", window=0, title="a;rm -rf /")
    assert r["ok"] is False and "bad window name" in r["error"]
    assert fake.cmd is None, "a bad window name must never reach the shell"
