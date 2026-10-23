#!/usr/bin/env python3
"""Workbench process-wide bridge holder.

Trimmed for the standalone kore package: all the RSI session-log / verdict /
loop readers that used to live here are gone (the dashboard no longer renders
goal/ralph/dag/verdict panels). What remains is the single reason server.py
still imports this module — it needs ONE bridge instance for the whole process,
because the bridge's per-session locks are module globals and two copies would
let two concurrent sends interleave keystrokes.
"""

from __future__ import annotations

import importlib.util
import os

# Absolute path to kore-bridge.py. Defaults to the sibling of this package root
# (…/kore/kore-bridge.py); override with $KORE_BRIDGE_PATH if you move it.
KORE_BRIDGE_PATH = os.environ.get(
    "KORE_BRIDGE_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "kore-bridge.py"))

_bridge = None


def bridge():
    """Import the MCP bridge as a library (its filename is not a valid module name)."""
    global _bridge
    if _bridge is None:
        spec = importlib.util.spec_from_file_location("kore_bridge_lib", KORE_BRIDGE_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _bridge = mod
    return _bridge
