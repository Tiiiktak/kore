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

  logs:  ~/.kore/kore.log
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
xterm.js terminal into any pane (keystrokes, resize, scroll).

## Add another machine

On the second machine, install kore with the same one-liner, then paste the join line the
server printed:

```bash
curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh
kore client --server <server-ip>:8198 --token <agent-token>
```

There is **no default** for `--server` or `--token`; both come from the server's join
line. The client runs its agent in the foreground (Ctrl-C to leave the cluster). Within the
agent TTL (~45s) the new machine's node appears in the dashboard roster, and you can start
and drive sessions on it exactly like the server's own node.

**Network reachability is mutual** — open both directions:

- client → server on the **dashboard port** (default `8198`): the client POSTs its
  heartbeat there.
- server → client on the **agent port** (`KORE_AGENT_PORT`, `0` = OS-chosen): the engine
  POSTs `/exec` and streams `/tap` there.

### The `kore` command

| command | what it does |
|---|---|
| `kore` / `kore server` (central node) | start the dashboard in the background, print a tokened link **and** the `kore client …` join command. Also a worker, so one machine needs nothing else. `kore server --restart` applies new config to a running board |
| `kore client --server <ip:port> --token <tok>` | join THIS machine as a worker node (paste the server's join line); no defaults |
| `kore down` | stop the background dashboard |
| `kore status` | is it up? reprint the link |
| `kore upgrade` | update kore in place to the latest release — `--version vX.Y.Z` to pin, `--check` to only compare. Handles an install.sh install (re-runs the installer), a git clone (fast-forwards it) and a `uv tool` install (reinstalls from git) |
| `kore --version` | print the installed version |
| `kore mcp` | run the MCP-over-stdio server (stdout = protocol JSON only) |
| `kore ops …` | the write-door / engine CLI (`policy`, `alive`, `roster`, `read`, …) |
| `kore doctor` | preflight the environment; PASS/WARN/FAIL table |

The cross-command "cluster identity" vars are top-level flags — put them **before** the
subcommand so server/client/mcp can't disagree: `--agent-token`, `--agents-file`,
`--prefix`, `--node-ip`. Example: `kore --agent-token "$TOK" server`.

Any tmux session whose name carries the prefix (`kore-*` by default) shows up on the board
automatically, on whichever node it lives.

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

## Configure

Everything is behind a `KORE_*` env var with a sane default — nothing is hardcoded. All
runtime state defaults under `~/.kore/` (override with `KORE_STATE_HOME`). Every variable
below is a `KORE_*` name — that is the only spelling the code reads.

| env | default | meaning |
|---|---|---|
| `KORE_AGENT_TOKEN` | *(minted)* | server↔client agent secret, and the client-join token. `kore server` mints one (`~/.kore/agent.token`, 0600) if unset. A client agent refuses to bind non-loopback without it. |
| `KORE_AGENTS_FILE` | `~/.kore/agents.json` | the client-agent registry (node_ip → url) the server writes |
| `KORE_AGENT_TTL` | `45` | seconds before a silent client is pruned from the roster |
| `KORE_AGENT_PORT` | `0` | client agent bind port; `0` = OS-chosen, written to `agent.port` |
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
`/api/agents` (the client registry, TTL-pruned).
`POST /api/kore/{start,stop,send,keys,input,resize}` drives a session.
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
