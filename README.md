# kore

Manage **kore sessions** — interactive Claude Code CLI running inside `tmux` across one or
more machines — and watch/drive them from a **web dashboard**, or expose them to an agent
as **MCP tools**. One command to start, no environment setup, stdlib only.

A "kore session" is a tmux session named `kore-<name>` on a machine running `claude`
interactively. The engine starts/stops those sessions, captures their panes, and types
into them over tmux (`send-keys` / `capture-pane` / control-mode `attach`).

## Server and client

kore has an explicit two-role model — there is no transport to choose and nothing is
hardcoded:

- **`kore server`** starts the central node: the dashboard, the engine, and the agent
  registry. **The server is also a worker**, so on a single machine `kore server` is all
  you need — the engine runs that host's tmux commands locally.
- **`kore client --server <ip:port> --token <tok>`** joins another machine as a worker.
  You don't type that line by hand: the server **prints it** (k3s / tailscale style), and
  you paste it on the new machine. The client runs a small stdlib agent that registers
  itself into the roster and answers the server over HTTP.

The engine routes **per node**: a command for the server's own host runs locally; a
command for a client runs over HTTP against that client's agent. No Ray, no shared
filesystem, no cluster manager.

```
browser ─HTTP─▶ server.py ─▶ koreops.py ─▶ kore-bridge.py ─┬─self──▶ subprocess on the server host ─▶ tmux kore-<name>
 xterm.js       (WB token)   (write door)  (engine)         │
 terminal                                                   └─client▶ kore-agent (on a client) ─HTTP─▶ tmux kore-<name>
                                       agent registry ◀── each client's agent POSTs /api/agents/register every ~15s
```

> **Env naming:** every setting is a `KORE_*` variable (`KORE_AGENT_TOKEN`, `KORE_NODE_IP`,
> …). This is the only spelling the code reads.

## Quickstart (one machine, zero config)

Install with one line, then run `kore`. No config files, no token to copy — all runtime
state lands under `~/.kore/`:

```bash
curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh
kore                                                   # start + print a link
```

kore is stdlib-only, so the installer needs nothing but **Python ≥ 3.8** and curl/wget —
no pip, no uv, no virtualenv. It downloads the latest release into
`~/.local/share/kore`, puts a `kore` launcher in `~/.local/bin`, and adds that dir to your
PATH if needed (open a new shell afterwards). Installer options go after `sh -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh -s -- --version v0.3.1
curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh -s -- --no-modify-path
curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh -s -- --uninstall
```

`kore` (same as `kore server`) mints the tokens it needs, starts the dashboard **in the
background**, waits for it to come up, and prints a **ready-to-click link with the access
token already in it** — one click, no login — plus the join command for adding more
machines:

```
kore server is up  —  pid 12345, prefix=kore-

  👉  open the dashboard (token included — one click, no login):

      http://<server-ip>:8198/?token=<token>
      http://127.0.0.1:8198/?token=<token>

  add another machine — run this on it (needs network both ways):

      kore client --server <server-ip>:8198 --token <agent-token>

      (kore not installed there yet?  curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh)

  logs:  ~/.kore/server-<host>.log
  stop:  kore down
```

`kore status` reprints the link; `kore down` stops it; `kore upgrade` updates in place.
Re-running `kore` is idempotent; if you pass config that disagrees with a board that's
already up it **warns** and tells you to `kore server --restart` (which tears the board
down and brings it back with the new config) instead of silently ignoring the flags.

Other ways to run it — all stdlib only:

```bash
uv tool install git+https://github.com/Tiiiktak/kore@v0.3.1   # via uv instead of install.sh

git clone https://github.com/Tiiiktak/kore && cd kore
./kore doctor        # preflight: tmux/claude on PATH, tokens, node-ip…
./kore               # same launcher, no install
```

From the dashboard you can list sessions, create/kill a kore session, and open a live
xterm.js terminal into any pane (keystrokes, resize, scroll). Sessions are grouped by the
machine they run on (the server's own host first, then each client, each with its own
color). Every session and machine gets a small ASCII icon — fruits and animals, picked
automatically from its name — and you can give it a nickname or pick another icon by
clicking that icon (saved on the server, so every device sees the same names). The
session tabs sit along the top or, on wide screens, in a left sidebar — toggle with the
button at the top right.

## Add another machine

The dashboard shows exactly what to run: click **+ 添加机器** (next to **+ 新建**) for the
install line and the join line, each with a copy button, plus the state of every machine
that has joined. The same join line is printed when you start `kore`. On the new machine:

```bash
curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh
kore client --server <server-ip>:8198 --token <agent-token>
```

There is **no default** for `--server` or `--token`; both come from the server's join
line. `kore client` runs **in the background** (like the server) and only returns once the
server has accepted the machine, so problems are reported right away instead of as a node
that never shows up:

- server not reachable from this machine → says so (check the address and port);
- wrong token → refused before anything is started or stopped;
- joined, but the server cannot connect back to this machine's agent → joins anyway and
  tells you which port to open (the node is listed, but its sessions cannot be driven yet).

`kore status` shows the client's state, `kore down` takes the machine out again, and
`kore client --foreground …` runs it attached to the terminal (systemd / debugging). The new
node appears in the roster at once, and you can start and drive sessions on it exactly like
the server's own node.

**Network reachability is mutual** — open both directions:

- client → server on the **dashboard port** (default `8198`): the client POSTs its
  heartbeat there.
- server → client on the **agent port** (default `8199`, `KORE_AGENT_PORT` to change; if
  8199 is taken the agent picks a free port and reports it): the engine POSTs `/exec` and
  streams `/tap` there.

### The `kore` command

| command | what it does |
|---|---|
| `kore` / `kore server` (central node) | start the dashboard in the background, print a tokened link **and** the `kore client …` join command. Also a worker, so one machine needs nothing else. `kore server --restart` applies new config to a running board |
| `kore client --server <ip:port> --token <tok>` | join THIS machine as a worker node, in the background (paste the server's join line); no defaults. `--foreground` to stay attached |
| `kore adopt [NAME…]` | bring tmux sessions that already run on this machine under kore: with no name it lists the ones without the prefix; `kore adopt work` renames `work` → `kore-work` (the programs inside keep running), `--all` adds every one. The dashboard's **+ 已有 session** does the same for any machine |
| `kore down` | stop whatever kore runs on this machine (the server and/or a client) |
| `kore status` | what runs on this machine: the server (with its link) and/or a client (with its registration state) |
| `kore upgrade` | update kore in place to the latest release — `--version vX.Y.Z` to pin, `--check` to only compare. Handles an install.sh install (re-runs the installer), a git clone (fast-forwards it) and a `uv tool` install (reinstalls from git) |
| `kore --version` | print the installed version |
| `kore mcp` | run the MCP-over-stdio server (stdout = protocol JSON only) |
| `kore ops …` | the write-door / engine CLI (`policy`, `alive`, `roster`, `read`, …) |
| `kore doctor` | preflight the environment; PASS/WARN/FAIL table |

The cross-command "cluster identity" vars are top-level flags — put them **before** the
subcommand so server/client/mcp can't disagree: `--agent-token`, `--agents-file`,
`--prefix`, `--node-ip`. Example: `kore --agent-token "$TOK" server`.

Any tmux session whose name carries the prefix (`kore-*` by default) shows up on the board
automatically, on whichever node it lives. A session you started yourself under another
name can be added with `kore adopt <name>` on that machine, or from the dashboard
(**+ 已有 session**): kore renames it into the prefix; nothing inside it is restarted.

## What's in the box

```
kore/                            repo root
├── install.sh                   one-line installer (`curl -fsSL … | sh`)
├── kore                         clone-and-run launcher (stdlib, no install)
├── pyproject.toml               packaging (hatchling; console-script `kore`)
├── tests/                       test_transport.py (self-local + http-client routing)
└── src/kore/
    ├── cli.py                   the CLI dispatch + env defaults + doctor
    ├── kore-bridge.py          engine; also an MCP-over-stdio server
    ├── koreops.py                 the single write door; reads the policy below
    ├── kore-agent.py              per-node HTTP agent run on a client: /exec /tap /ping
    ├── dispatch-allowlist.json  the kore write policy (nodes / verbs / protected / limits)
    └── workbench/
        ├── server.py            the HTTP dashboard + SSE terminal server
        ├── state.py             holds one process-wide bridge instance
        ├── index.html           the dashboard UI (xterm.js terminal, session list)
        ├── service.sh           bare start/stop/restart/status (for systemd ops)
        └── vendor/xterm/        pinned xterm.js (served locally, no CDN)
```

## Prerequisites

- **The server host**: Python 3.8+, `tmux`, and the `claude` CLI on `PATH` (or pass an
  explicit `claude_path` on start). Stdlib only — no third-party runtime dependencies.
- **Each client machine**: the same — Python 3.8+, `tmux`, `claude`. It runs the agent
  (stdlib only). The server must be able to reach the client's agent port over the network,
  and the client must be able to reach the server's dashboard port.
- **tmux 3.0+ is recommended, not required.** Older tmux works with degraded features (below
  2.9 the dashboard cannot fit the window to the browser). `kore doctor` reports your tmux
  version and prints concrete upgrade commands for your system (package manager, Homebrew,
  conda-forge, or building from source), and `kore` warns at startup when tmux is old.

**Window size, browser vs your own terminal.** A tmux window has one size shared by every
client. kore follows whoever is using it: while the dashboard has focus it fits the window
to the browser; the moment you switch away (to your own `tmux attach`, another window or
tab) the window is handed back to tmux and your terminal gets its own size back. This works
on every tmux version (it emulates tmux 3.1's `window-size latest`).

## Configure

Everything is behind a `KORE_*` env var with a sane default — nothing is hardcoded. All
runtime state defaults under `~/.kore/` (override with `KORE_STATE_HOME`). Every variable
below is a `KORE_*` name — that is the only spelling the code reads.

| env | default | meaning |
|---|---|---|
| `KORE_AGENT_TOKEN` | *(minted)* | server↔client agent secret, and the client-join token. `kore server` mints one (`~/.kore/agent.token`, 0600) if unset. A client agent refuses to bind non-loopback without it. |
| `KORE_AGENTS_FILE` | `~/.kore/agents.json` | the client-agent registry (node_ip → url) the server writes |
| `KORE_AGENT_TTL` | `45` | seconds before a silent client is pruned from the roster |
| `KORE_AGENT_PORT` | `8199` | client agent bind port (falls back to a free port when 8199 is taken); `0` = always OS-chosen |
| `KORE_AGENT_BIND` | `0.0.0.0` | client agent bind address |
| `KORE_BRIDGE_URL` | *(set by `kore client`)* | the server's web base URL the client POSTs to; `kore client --server` sets it |
| `KORE_NODE_IP` | *(autodetect)* | override a node's advertised IP (use the reachable one) |
| `WB_HOST` / `WB_PORT` | `0.0.0.0` / `8198` | dashboard bind address / port |
| `WB_TOKEN_FILE` | `~/.kore/wb.token` | WB (browser↔dashboard) shared-token file |

Other engine env (all optional): `KORE_BRIDGE_PREFIX` (tmux name prefix, default `kore-`),
`KORE_REGISTRY` (the separate name→node **session** registry, default
`~/.kore/sessions.json`), `KORE_MAX_OUTPUT_CHARS`, `WB_PORT_ALSO`, `WB_MAX_STREAMS`,
`WB_STREAM_*`.

**Scope the write policy** in `src/kore/dispatch-allowlist.json` → `kore`:
- `nodes`: `["*"]` = any routable node (the server's own host, or any client with a fresh
  agent), or list specific worker IPs.
- `deny_nodes`, `protected_sessions` (read-only names), `verbs`, `cwd_roots`,
  `allowed_keys`, `max_per_minute`, … — see the comments in the file. Edits take effect
  with no restart.

## HTTP endpoints (all need the WB token except `/api/health`)

`GET /api/state` · `/api/kore/roster` · `/api/kore/read` · `/api/kore/stream` (SSE line-diff) ·
`/api/kore/bytes` (SSE byte relay) · `/api/kore/status` · `/api/kore/jobs` · `/api/kore/job` ·
`/api/agents` (the client registry, TTL-pruned) · `/api/join` (the add-a-machine panel).
`GET /api/kore/unmanaged?node_ip=` lists a node's tmux sessions without the prefix.
`POST /api/kore/{start,stop,send,keys,input,resize,adopt}` drives a session (`adopt` renames
an existing session into the prefix).
`POST /api/labels` sets a nickname / icon for a node or session (dashboard-only, no node is touched).
`POST /api/agents/register` is the client registry-push door — fenced by `KORE_AGENT_TOKEN`,
a **different** token domain from the dashboard's WB token.

Reads accept `Authorization: Bearer <tok>` **or** `?token=<tok>`. Writes accept the
**Bearer header only**, and must echo `confirm: "<verb>:<node_ip>:<session>"`.

## Run as an MCP server (for an agent)

`kore mcp` is a standalone MCP-over-stdio server (`stdout` carries protocol JSON only;
logs go to `stderr`). Example MCP client config:

```json
{
  "mcpServers": {
    "kore": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/Tiiiktak/kore@v0.3.1", "kore", "mcp"],
      "env": { "KORE_AGENT_TOKEN": "<shared-secret>" }
    }
  }
}
```

Tools exposed: `kore_cluster`, `kore_list`, `kore_start`, `kore_send`, `kore_read`, `kore_keys`,
`kore_status`, `kore_stop`, `node_run`, `node_read`.

> **Policy scope:** `dispatch-allowlist.json` is enforced only on the **web path**
> (`server.py` → `koreops.py`). The MCP tools call the engine **directly** and do **not**
> consult the allowlist — anyone who can speak to the MCP server's stdin can drive any
> session on any node the engine can route to. Only expose it to a trusted agent.

## Security notes

- The dashboard port carries **writes** (start/kill claude sessions, type into panes).
  One shared WB token is the whole fence — keep `WB_HOST=0.0.0.0` only with that token in
  force, or set `WB_HOST=127.0.0.1` and tunnel.
- The WB token may appear in URLs (EventSource / `<script src>` can't send headers); it is
  redacted from the server's own access log but treat it as sensitive.
- **Two distinct token domains — do not conflate them.** The WB token (browser→server,
  == the share-link token) is NOT the agent token. `KORE_AGENT_TOKEN` (server→client, the
  client-join secret, and the `POST /api/agents/register` fence) is a separate secret; a
  browser token can never register a client or reach a node, and an agent token can never
  drive a pane.
- The engine will `POST /exec` (**arbitrary command execution**) to any client with a fresh
  registry entry whose agent honors `KORE_AGENT_TOKEN`. It is **leak-sensitive**: anyone
  holding the agent token who can reach a client's agent port has RCE on that machine. Set a
  strong `KORE_AGENT_TOKEN`, keep `agents.json` and the token off world-readable paths, and
  prefer explicit `nodes` over `["*"]`. An empty token disables client joins entirely, and a
  client agent then refuses to bind anything but `127.0.0.1`.
- `/tap` is read-only by construction (`tmux -C attach -r`).

## Contributing & releases

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `py_compile`, the routing tests,
`bash -n service.sh`, JSON validation, and a packaging smoke that installs the wheel and
proves every data file shipped. Cutting a release: push a `vX.Y.Z` tag (matching
`src/kore/__init__.py`) and the release workflow builds the wheel + sdist and attaches
them to a GitHub Release. Users then run `uvx --from git+…@vX.Y.Z kore …`.

## License

MIT — see [LICENSE](LICENSE). Bundles xterm.js under its own MIT license
(`src/kore/workbench/vendor/xterm/LICENSE-*.txt`).
