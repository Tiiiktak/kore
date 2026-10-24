#!/usr/bin/env python3
"""Structural guards for the dashboard (2026-10-24 design/security audit).

The browser-window proxy's SERVER side is the load-bearing security boundary, and it is
pinned here so a later edit cannot quietly undo it:

  * the wview responses are CSP-sandboxed (opaque origin), never same-origin;
  * the wview credential is a scoped, expiring ticket — never the board token;
  * the proxy refuses link-local / metadata addresses after DNS resolution.

The old hand-written index.html also carried DOM/CSS guards (the browser iframe's sandbox
attribute, no icon/dot on window types, the overview yielding its keyboard to the stage, no
one-sided row stripe). Those asserted against a specific HTML structure that the
React/shadcn frontend replaced at cut-over, so they were removed with it: the iframe-sandbox
property now lives in `web/src/components/wm/BrowserView.tsx` (its sandbox has no
`allow-same-origin`), and the CSP boundary guarded below is what actually contains a hostile
proxied page regardless of the iframe attribute.

Run: `python -m pytest -q tests` (stdlib only).
"""

import ast
import hashlib
import hmac
import os
import socket
import time

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")
SERVER = os.path.join(HERE, "workbench", "server.py")


def _server_defs(*names, **ns):
    """Pull top-level functions / assignments out of server.py by AST, without starting it."""
    src = open(SERVER, encoding="utf-8").read()
    body = [n for n in ast.parse(src).body
            if (isinstance(n, ast.FunctionDef) and n.name in names)
            or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in names for t in n.targets))]
    ns = {"hmac": hmac, "hashlib": hashlib, "time": time, "socket": socket, **ns}
    exec(compile(ast.Module(body=body, type_ignores=[]), "server.py", "exec"), ns)
    return ns


def test_wview_responses_are_sandboxed():
    ns = _server_defs("WVIEW_HEADERS", "PAGE_HEADERS")
    csp = ns["WVIEW_HEADERS"]["Content-Security-Policy"]
    assert csp.startswith("sandbox") and "allow-same-origin" not in csp
    assert ns["WVIEW_HEADERS"]["Referrer-Policy"] == "no-referrer"
    assert "frame-ancestors 'self'" in ns["PAGE_HEADERS"]["Content-Security-Policy"]


def test_wview_ticket_scoped_and_expiring():
    ns = _server_defs("_wview_ticket", "_wview_ticket_ok", TOKEN="board-secret", WVIEW_TTL=60)
    t = ns["_wview_ticket"]()
    assert t.startswith("wv1.") and "board-secret" not in t
    assert ns["_wview_ticket_ok"](t)
    assert not ns["_wview_ticket_ok"]("board-secret")
    assert not ns["_wview_ticket_ok"](t[:-1] + ("0" if t[-1] != "0" else "1"))
    assert not ns["_wview_ticket_ok"](ns["_wview_ticket"](int(time.time()) - 5))   # expired


def test_wview_blocks_metadata_addresses():
    ns = _server_defs("_wview_host_ok")
    ok = ns["_wview_host_ok"]
    assert ok("169.254.169.254")
    assert ok("2852039166")             # decimal form of 169.254.169.254
    assert ok("0.0.0.0")
    assert ok("127.0.0.1") == ""        # previewing your own dev server is the feature
