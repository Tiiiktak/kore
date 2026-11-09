"""Share links: the store (hash-only, expiry, revoke, per-link chat budget) and log redaction."""
import ast
import importlib.util
import json
import os
import re
import tempfile
import time

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")


def _shares():
    spec = importlib.util.spec_from_file_location("t_shares", os.path.join(HERE, "workbench", "shares.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_create_lookup_revoke_expiry():
    m = _shares()
    path = os.path.join(tempfile.mkdtemp(), "shares.json")
    st = m.ShareStore(path)
    s = st.create("10.1.1.1", "kore-a", "chat", 3600, "for bob")
    tok = s.pop("token")
    assert st.lookup(tok)["name"] == "kore-a"
    raw = open(path).read()
    assert tok not in raw, "only the token's hash is persisted"
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"
    assert st.lookup(tok + "x") is None and st.lookup("") is None
    assert [x["id"] for x in st.list("10.1.1.1", "kore-a")] == [s["id"]]
    assert "hash" not in st.list("10.1.1.1", "kore-a")[0], "owner view never shows the hash"
    # a fresh store (board restart) still knows the link
    assert m.ShareStore(path).lookup(tok) is not None
    assert st.revoke(s["id"]) and st.lookup(tok) is None and st.list("10.1.1.1", "kore-a") == []
    # expiry
    s2 = st.create("10.1.1.1", "kore-a", "read", 60)
    st._load()[s2["id"]]["expires_at"] = time.time() - 1
    assert st.lookup(s2["token"]) is None
    print("ok  shares: hash-only at rest, 0600, survive restart, revoke + expiry kill the link")


def test_validation_and_chat_budget():
    m = _shares()
    st = m.ShareStore(os.path.join(tempfile.mkdtemp(), "s.json"))
    for bad in (("10.1.1.1", "kore-a", "write", 3600), ("10.1.1.1", "kore-a", "read", 10),
                ("10.1.1.1", "kore-a", "read", 10 ** 9)):
        try:
            st.create(*bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"must refuse {bad}")
    sid = st.create("10.1.1.1", "kore-a", "chat", 3600)["id"]
    oks = [st.chat_allowed(sid) for _ in range(m.CHAT_PER_MINUTE + 2)]
    assert oks.count(True) == m.CHAT_PER_MINUTE and oks[-1] is False
    print("ok  shares: scope/ttl validated; per-link chat budget enforced")


def test_reply_after():
    m = _shares()
    screen = "old stuff\n> what is 2+2\n\n⏺ 4\n\n> "
    assert m.reply_after(screen, "what is 2+2") == "\n⏺ 4\n\n> ".strip("\n")
    assert m.reply_after("no echo here", "zzz") == "no echo here"
    print("ok  shares: reply is cut after the echoed message")


def test_share_tokens_redacted_in_log():
    src = open(os.path.join(HERE, "workbench", "server.py"), encoding="utf-8").read()
    ns = {"re": re}
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") in ("_TOKEN_IN_URL", "_SHARE_IN_URL") for t in node.targets):
            exec(compile(ast.Module([node], []), "server.py", "exec"), ns)
        if isinstance(node, ast.FunctionDef) and node.name == "_redact":
            exec(compile(ast.Module([node], []), "server.py", "exec"), ns)
    out = ns["_redact"]('"GET /s/AbC-123_x HTTP/1.1" "POST /api/share/QQQ_w/send" /?token=SECRET')
    assert "AbC-123_x" not in out and "QQQ_w" not in out and "SECRET" not in out, out
    assert "/api/share/<redacted>/send" in out
    print("ok  log redaction covers share tokens in the path")
