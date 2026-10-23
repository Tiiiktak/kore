# Contributing to kore

Thanks for hacking on kore. It is deliberately small and **stdlib-only** — no third-party
runtime dependencies. Please keep it that way.

## Layout

```
src/kore/            the package (shipped as a wheel)
  cli.py             the CLI: server/client/down/status/upgrade/mcp/ops/doctor
  koreops.py           the write door + resident write/read/tap children
  kore-bridge.py    the engine; also an MCP-over-stdio server
  kore-agent.py        per-node HTTP agent run on a client
  workbench/         the dashboard (server.py, index.html, vendor/xterm)
tests/               test_transport.py (self-local + http-client routing)
kore                 clone-and-run launcher (no install needed)
```

The hyphenated / extension-less scripts (`kore-bridge.py`, `kore-agent.py`) are **run by
path**, never imported as modules. `cli.py` dispatches to them with `runpy.run_path`. Do
not rename them without updating every path default that points at them (`server.py`
`KORE_OPS_PATH`, `state.py` `KORE_BRIDGE_PATH`, koreops' `KORE_AGENT_PATH`, and koreops'
own `abspath(__file__)` self-relaunch).

## Dev loop

```bash
./kore doctor                     # preflight your environment
python tests/test_transport.py    # routing unit tests (no network, no second machine)
uv build                          # build the wheel + sdist
uvx --from ./dist/*.whl kore doctor   # prove the wheel shipped all data files
```

## Routing and tokens

There is no transport switch. The engine's `sh(node_ip)` decides **per node**: the
server's own host (`_local_node_ip()`) runs locally with `subprocess`; every other node is
reached over HTTP against its client agent. When you touch the node-reaching seams, keep
both paths returning the identical `{stdout, stderr, rc}` contract and the identical
`r/o/g/h/e` tap byte protocol.

There are **two distinct token domains** — never conflate them:

- `KORE_AGENT_TOKEN` — server ↔ client agent; the fence in front of `/exec` (arbitrary
  RCE) and the token a client presents to join.
- the WB token (`WB_TOKEN_FILE`) — browser ↔ dashboard; it is also the share-link token.

A browser token can never register or reach a client agent; an agent token can never drive
a pane. Keep it that way.

## Pull requests

CI runs `py_compile`, the routing tests, `bash -n` on `service.sh`, JSON validation of
`dispatch-allowlist.json`, and a packaging smoke (`uvx … kore doctor`). Please make sure
all of that is green locally first.

GitHub sees only `main`. Day-to-day work happens on a local `dev` branch; a release is a
fast-forward (or squash) of `dev` into `main`, then `git push origin main`. A tracked
pre-push hook (`scripts/pre-push`, installed to `.git/hooks/pre-push`) rejects pushing any
ref except `main` and tags, so local branches never leak.
