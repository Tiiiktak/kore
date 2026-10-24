#!/usr/bin/env python3
"""File-browser API: the node-side fixed script (`koreops._FS_SCRIPT`).

Runs the exact shell command `_fs_cmd()` builds, the same way `_sh_local` would
(`subprocess.run(cmd, shell=True)`), against a temp HOME. Session roots use a private
tmux server (TMUX_TMPDIR in the temp dir) and are skipped when tmux is missing.

Run: `python -m pytest -q tests` (stdlib + pytest only).
"""

import importlib.util
import os
import shutil
import subprocess
import time

import pytest

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")
_spec = importlib.util.spec_from_file_location("t_koreops_fs", os.path.join(HERE, "koreops.py"))
ko = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ko)

PREFIX = "kfstest-"


@pytest.fixture()
def env(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    tdir = tmp_path / "tmux"
    tdir.mkdir()
    e = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    e["HOME"] = str(home)
    e["TMUX_TMPDIR"] = str(tdir)
    yield {"home": home, "env": e, "tmp": tmp_path}
    if shutil.which("tmux"):
        subprocess.run(["tmux", "kill-server"], env=e, capture_output=True)


def run(env, **req):
    req.setdefault("prefix", PREFIX)
    r = subprocess.run(ko._fs_cmd(req), shell=True, capture_output=True, text=True,
                       env=env["env"], timeout=30)
    got = ko._fs_parse(r.stdout)
    assert got is not None, (r.stdout, r.stderr)
    return got


def real(p):
    return os.path.realpath(str(p))


# ------------------------------------------------------------------ roots

def test_roots_home_only(env):
    r = run(env, op="roots", prefix="")
    assert r["ok"] is True
    assert r["roots"] == [{"id": real(env["home"]), "label": "主目录", "path": real(env["home"])}]


@pytest.mark.skipif(not shutil.which("tmux"), reason="tmux not installed")
def test_roots_sessions_then_home_deduped(env):
    proj = env["tmp"] / "proj"
    proj.mkdir()
    e = env["env"]
    subprocess.run(["tmux", "new-session", "-d", "-s", PREFIX + "alpha", "-c", str(proj)], env=e, check=True)
    subprocess.run(["tmux", "new-session", "-d", "-s", PREFIX + "beta", "-c", str(proj)], env=e, check=True)
    subprocess.run(["tmux", "new-session", "-d", "-s", PREFIX + "home", "-c", str(env["home"])], env=e, check=True)
    subprocess.run(["tmux", "new-session", "-d", "-s", "other", "-c", str(env["tmp"])], env=e, check=True)
    time.sleep(0.3)
    r = run(env, op="roots")
    assert r["ok"] is True
    paths = [x["path"] for x in r["roots"]]
    assert paths == [real(proj), real(env["home"])]           # deduped, order kept, no "other"
    assert r["roots"][0]["label"] == "alpha · proj"
    assert r["roots"][1]["label"] == "home · home"             # session wins over 主目录
    assert all(x["id"] == x["path"] for x in r["roots"])
    # the session cwd is browsable
    lst = run(env, op="list", path=str(proj))
    assert lst["ok"] and lst["parent"] is None and lst["root"] == real(proj)


# ------------------------------------------------------------------ list

def test_list_sort_hidden_parent(env):
    h = env["home"]
    (h / "b").mkdir()
    (h / "A").mkdir()
    for n in ("file10.txt", "file2.txt", "File1.txt", ".dot"):
        (h / n).write_text("x")
    (h / "b" / "inner").write_text("y")
    r = run(env, op="list", path=str(h))
    assert r["ok"] is True
    assert r["path"] == real(h) and r["parent"] is None and r["root"] == real(h)
    assert [e["name"] for e in r["entries"]] == ["A", "b", "File1.txt", "file2.txt", "file10.txt"]
    assert [e["kind"] for e in r["entries"]] == ["dir", "dir", "file", "file", "file"]
    e = r["entries"][2]
    assert isinstance(e["size"], int) and isinstance(e["mtime"], float) and e["size"] == 1
    assert r["truncated"] is False
    r2 = run(env, op="list", path=str(h), hidden=True)
    assert ".dot" in [e["name"] for e in r2["entries"]]
    sub = run(env, op="list", path=str(h / "b"))
    assert sub["parent"] == real(h) and sub["root"] == real(h)
    assert [e["name"] for e in sub["entries"]] == ["inner"]


def test_list_truncates(env):
    d = env["home"] / "many"
    d.mkdir()
    for i in range(2105):
        (d / f"f{i}").touch()
    r = run(env, op="list", path=str(d))
    assert r["truncated"] is True and len(r["entries"]) == 2000
    assert r["entries"][0]["name"] == "f0" and r["entries"][10]["name"] == "f10"


def test_list_symlinks(env, tmp_path):
    h = env["home"]
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("nope")
    (h / "real").mkdir()
    (h / "in_link").symlink_to(h / "real")
    (h / "out_link").symlink_to(outside)
    (h / "file_link").symlink_to(outside / "secret.txt")
    (h / "dangling").symlink_to(h / "missing")
    r = run(env, op="list", path=str(h))
    by = {e["name"]: e for e in r["entries"]}
    assert by["in_link"]["kind"] == "dir" and by["in_link"]["target"] == str(h / "real")
    assert by["out_link"]["kind"] == "dir" and "target" in by["out_link"]
    assert by["file_link"]["kind"] == "file"
    assert by["dangling"]["kind"] == "link" and by["dangling"]["broken"] is True
    assert "broken" not in by["in_link"]
    # dirs (including links to dirs) first
    kinds = [e["kind"] for e in r["entries"]]
    assert kinds == sorted(kinds, key=lambda k: k != "dir")
    # following a link inside the root works and reports the realpath
    ok = run(env, op="list", path=str(h / "in_link"))
    assert ok["ok"] and ok["path"] == real(h / "real") and ok["parent"] == real(h)
    # following a link out of the root is refused, for list and read
    assert "refused" in run(env, op="list", path=str(h / "out_link"))
    assert "refused" in run(env, op="read", path=str(h / "file_link"))


def test_list_errors_are_not_refusals(env):
    h = env["home"]
    (h / "f").write_text("x")
    r = run(env, op="list", path=str(h / "nope"))
    assert r["ok"] is False and "error" in r and "refused" not in r
    r = run(env, op="list", path=str(h / "f"))
    assert r["ok"] is False and "不是目录" in r["error"]


# ------------------------------------------------------------------ read

def test_read_text(env):
    p = env["home"] / "a.txt"
    p.write_text("hello\n世界\n", encoding="utf-8")
    r = run(env, op="read", path=str(p))
    assert r["ok"] is True and r["binary"] is False and r["truncated"] is False
    assert r["text"] == "hello\n世界\n" and r["size"] == len("hello\n世界\n".encode())
    assert r["path"] == real(p) and isinstance(r["mtime"], float)


def test_read_gb18030(env):
    p = env["home"] / "gb.txt"
    p.write_bytes(("中文内容，测试编码。" * 20).encode("gb18030"))
    r = run(env, op="read", path=str(p))
    assert r["binary"] is False and r["text"].startswith("中文内容")


def test_read_binary(env):
    p = env["home"] / "b.bin"
    p.write_bytes(b"\x7fELF\x00\x01\x02" + os.urandom(2000))
    r = run(env, op="read", path=str(p))
    assert r["ok"] is True and r["binary"] is True and r["text"] == ""
    q = env["home"] / "noise.bin"
    q.write_bytes(bytes(range(128, 256)) * 40)     # no NUL, but undecodable
    assert run(env, op="read", path=str(q))["binary"] is True


def test_read_truncation_and_tail(env):
    p = env["home"] / "big.log"
    lines = [f"line {i:07d}" for i in range(60000)]          # 13 B/line -> ~780 KiB
    p.write_text("\n".join(lines) + "\n")
    head = run(env, op="read", path=str(p))
    assert head["truncated"] is True and len(head["text"].encode()) == 512 * 1024
    assert head["text"].startswith("line 0000000\n")
    tail = run(env, op="read", path=str(p), tail=0)            # last 512 KiB, whole lines
    assert tail["truncated"] is True and tail["text"].endswith("line 0059999\n")
    assert tail["text"].split("\n", 1)[0].startswith("line ")
    assert len(tail["text"].encode()) <= 512 * 1024
    t3 = run(env, op="read", path=str(p), tail=3)
    assert t3["text"] == "line 0059997\nline 0059998\nline 0059999\n" and t3["truncated"] is True
    small = env["home"] / "s.txt"
    small.write_text("a\nb\n")
    r = run(env, op="read", path=str(small), tail=10)
    assert r["text"] == "a\nb\n" and r["truncated"] is False


def test_read_dir_and_missing(env):
    r = run(env, op="read", path=str(env["home"]))
    assert r["ok"] is False and "目录" in r["error"]
    r = run(env, op="read", path=str(env["home"] / "missing"))
    assert r["ok"] is False and "不存在" in r["error"]


# ------------------------------------------------------------------ refusals

def test_refuse_outside_roots_and_system(env, tmp_path):
    (tmp_path / "x.txt").write_text("x")
    for op in ("list", "read"):
        assert "refused" in run(env, op=op, path=str(tmp_path / "x.txt"))
    for p in ("/proc/self/environ", "/sys", "/dev/null", "/etc/passwd", "/"):
        r = run(env, op="read", path=p)
        assert r["ok"] is False and "refused" in r, p
    assert "refused" in run(env, op="list", path="relative/path")
    assert "refused" in run(env, op="list", path=str(env["home"]) + "/../" + "outside")


def test_refuse_secret_dirs_and_files(env):
    h = env["home"]
    for d in (".ssh", ".kore", ".cc-bridge-dsh"):
        (h / d).mkdir()
        (h / d / "f").write_text("secret")
    (h / ".kore" / "agent.token").write_text("tok")
    (h / "proj").mkdir()
    (h / "proj" / "id_rsa").write_text("key")
    (h / "proj" / "server.pem").write_text("key")
    (h / "proj" / ".token").write_text("tok")
    (h / "proj" / "ok.txt").write_text("fine")
    (h / "proj" / "sneaky").symlink_to(h / ".ssh" / "f")
    for p in (h / ".ssh", h / ".ssh" / "f", h / ".kore" / "agent.token", h / ".cc-bridge-dsh"):
        for op in ("list", "read"):
            assert "refused" in run(env, op=op, path=str(p)), (op, p)
    for n in ("id_rsa", "server.pem", ".token", "sneaky"):
        assert "refused" in run(env, op="read", path=str(h / "proj" / n)), n
    assert run(env, op="read", path=str(h / "proj" / "ok.txt"))["text"] == "fine"
    # secret dirs/files are not even listed
    names = [e["name"] for e in run(env, op="list", path=str(h), hidden=True)["entries"]]
    assert ".ssh" not in names and ".kore" not in names and ".cc-bridge-dsh" not in names
    names = [e["name"] for e in run(env, op="list", path=str(h / "proj"), hidden=True)["entries"]]
    assert "id_rsa" not in names and ".token" not in names and "ok.txt" in names


def test_hostile_path_is_inert(env, tmp_path):
    """The path is data, not code: shell / python metacharacters do nothing."""
    canary = tmp_path / "pwned"
    evil = str(env["home"]) + f"/'; touch {canary}; echo '\"$(touch {canary})`touch {canary}`"
    r = run(env, op="list", path=evil)
    assert r["ok"] is False
    assert not canary.exists()


def test_cmd_never_contains_input():
    cmd = ko._fs_cmd({"op": "read", "path": "/tmp/MARKER-$(id)"})
    assert "MARKER" not in cmd and "$(id)" not in cmd


def test_server_side_path_check():
    with pytest.raises(ko.KoreOpsError):
        ko._fs_path_arg("relative")
    with pytest.raises(ko.KoreOpsError):
        ko._fs_path_arg("/a\x00b")
    assert "fs" in ko._PROBE_KINDS


# ------------------------------------------------------------------ readb (byte range)

import base64 as _b64  # noqa: E402


def test_readb_round_trip(env):
    p = env["home"] / "img.bin"
    blob = os.urandom(300_000)
    p.write_bytes(blob)
    got = bytearray()
    off = 0
    while True:
        r = run(env, op="readb", path=str(p), offset=off, len=100_000)
        assert r["ok"] is True and r["size"] == len(blob) and r["offset"] == off
        chunk = _b64.b64decode(r["data"])
        assert len(chunk) == r["len"]
        got += chunk
        off += r["len"]
        if r["eof"]:
            break
        assert r["len"] > 0
    assert bytes(got) == blob


def test_readb_caps_one_call(env):
    p = env["home"] / "big.bin"
    p.write_bytes(os.urandom(1_300_000))
    r = run(env, op="readb", path=str(p), offset=0, len=0)   # len<=0 -> CAP (1 MiB)
    assert r["len"] == 1_048_576 and r["eof"] is False
    r2 = run(env, op="readb", path=str(p), offset=0, len=9_000_000)   # len>CAP -> CAP
    assert r2["len"] == 1_048_576


def test_readb_refuses_and_errors(env, tmp_path):
    assert "refused" in run(env, op="readb", path=str(tmp_path / "x"))     # outside roots
    assert "refused" in run(env, op="readb", path="/etc/passwd")
    r = run(env, op="readb", path=str(env["home"]))
    assert r["ok"] is False and "目录" in r["error"]                       # a dir is not a file


# ------------------------------------------------------------------ WRITES (fixed script)

def runw(env, **req):
    """Run the fixed WRITE script the same way _sh_local would."""
    req.setdefault("prefix", PREFIX)
    r = subprocess.run(ko._fs_write_cmd(req), shell=True, capture_output=True, text=True,
                       env=env["env"], timeout=30)
    got = ko._fs_parse(r.stdout)
    assert got is not None, (r.stdout, r.stderr)
    return got


def test_mkdir_in_root(env):
    h = env["home"]
    r = runw(env, op="mkdir", path=str(h / "newdir"))
    assert r["ok"] is True and r["path"] == real(h / "newdir")
    assert (h / "newdir").is_dir()
    # already exists -> error (not a refusal)
    r2 = runw(env, op="mkdir", path=str(h / "newdir"))
    assert r2["ok"] is False and "已存在" in r2["error"]
    # missing parent -> error
    r3 = runw(env, op="mkdir", path=str(h / "a" / "b"))
    assert r3["ok"] is False and "父目录不存在" in r3["error"]


def test_rename_in_root(env):
    h = env["home"]
    (h / "src.txt").write_text("hi")
    r = runw(env, op="rename", path=str(h / "src.txt"), dst=str(h / "dst.txt"))
    assert r["ok"] is True
    assert not (h / "src.txt").exists() and (h / "dst.txt").read_text() == "hi"
    # destination already exists -> error
    (h / "a.txt").write_text("a")
    (h / "b.txt").write_text("b")
    r2 = runw(env, op="rename", path=str(h / "a.txt"), dst=str(h / "b.txt"))
    assert r2["ok"] is False and "已存在" in r2["error"]


def test_delete_file_and_tree(env):
    h = env["home"]
    (h / "gone.txt").write_text("x")
    r = runw(env, op="delete", path=str(h / "gone.txt"))
    assert r["ok"] is True and r["deleted"] == "file" and not (h / "gone.txt").exists()
    # empty dir
    (h / "empty").mkdir()
    r = runw(env, op="delete", path=str(h / "empty"))
    assert r["ok"] is True and r["deleted"] == "dir"
    # non-empty tree -> hard rmtree
    d = h / "tree"
    (d / "sub").mkdir(parents=True)
    (d / "sub" / "f").write_text("y")
    r = runw(env, op="delete", path=str(d))
    assert r["ok"] is True and r["deleted"] == "tree" and not d.exists()
    # a root itself cannot be deleted
    assert "refused" in runw(env, op="delete", path=str(h))


def test_put_truncate_then_append(env):
    h = env["home"]
    p = h / "up.bin"
    blob = os.urandom(90_000)
    chunks = [blob[i:i + 30_000] for i in range(0, len(blob), 30_000)]
    first = True
    for c in chunks:
        r = runw(env, op="put", path=str(p), data=_b64.b64encode(c).decode(),
                 append=not first)
        assert r["ok"] is True and r["bytes"] == len(c)
        first = False
    assert p.read_bytes() == blob
    # a second upload with append=False truncates
    r = runw(env, op="put", path=str(p), data=_b64.b64encode(b"new").decode(), append=False)
    assert r["ok"] is True and p.read_bytes() == b"new"


def test_put_bad_base64(env):
    assert "refused" in runw(env, op="put", path=str(env["home"] / "x"), data="!!!not b64!!!")


def test_writes_refuse_outside_roots_and_secrets(env, tmp_path):
    h = env["home"]
    # outside any root
    assert "refused" in runw(env, op="mkdir", path=str(tmp_path / "evil"))
    assert "refused" in runw(env, op="put", path=str(tmp_path / "evil.txt"),
                             data=_b64.b64encode(b"x").decode())
    assert not (tmp_path / "evil").exists() and not (tmp_path / "evil.txt").exists()
    # .. traversal out of the root
    assert "refused" in runw(env, op="mkdir", path=str(h) + "/../escaped")
    # secret dirs / key-named files, even inside a root
    (h / ".ssh").mkdir()
    assert "refused" in runw(env, op="put", path=str(h / ".ssh" / "authorized_keys"),
                             data=_b64.b64encode(b"x").decode())
    assert "refused" in runw(env, op="put", path=str(h / "id_rsa"),
                             data=_b64.b64encode(b"x").decode())
    assert "refused" in runw(env, op="mkdir", path="/etc/evil")
    # rename cannot move a file OUT of the roots, nor pull one in from outside
    (h / "f.txt").write_text("x")
    assert "refused" in runw(env, op="rename", path=str(h / "f.txt"),
                             dst=str(tmp_path / "out.txt"))
    (tmp_path / "in.txt").write_text("x")
    assert "refused" in runw(env, op="rename", path=str(tmp_path / "in.txt"),
                             dst=str(h / "in.txt"))


def test_rename_refuses_into_secret(env):
    h = env["home"]
    (h / "plain.txt").write_text("x")
    assert "refused" in runw(env, op="rename", path=str(h / "plain.txt"),
                             dst=str(h / "stolen.pem"))


def test_write_cmd_never_contains_input():
    cmd = ko._fs_write_cmd({"op": "mkdir", "path": "/tmp/MARKER-$(id)"})
    assert "MARKER" not in cmd and "$(id)" not in cmd


def test_put_chunk_fits_arg_limit():
    """The whole `sh -c` command for a max chunk must stay under MAX_ARG_STRLEN (128 KiB)."""
    chunk = ko.DEFAULT_POLICY["fs"]["put_chunk_bytes"]
    data = _b64.b64encode(os.urandom(chunk)).decode()
    cmd = ko._fs_write_cmd({"op": "put", "path": "/home/user/some/reasonable/path.bin",
                            "data": data, "append": True, "prefix": "kore-",
                            "deny_extra": ["/x/.token"]})
    assert len(cmd.encode()) < 128 * 1024, len(cmd.encode())
