# CLAUDE.md

kore — a small, **stdlib-only** (no third-party runtime deps) tmux-session dashboard +
engine. `CONTRIBUTING.md` has the module layout, the two token domains, the routing
contract, and the release model — read it; this file is the fast path for common tasks.
Keep the runtime stdlib-only.

## Commands

Backend (Python, stdlib + pytest):
```bash
python -m pytest -q tests     # all tests: routing, fs sandbox, dashboard/status guards
./kore doctor                 # preflight the environment
./kore server --restart       # (re)start the local board (self node), applying config
```

Frontend — `src/kore/workbench/web` (React + TS + Tailwind + shadcn/ui):
```bash
cd src/kore/workbench/web
npm run dev     # Vite HMR on :8290, proxies /api,/ws,/vendor → board :8198
npm run build   # tsc -b && vite build → ONE self-contained dist/index.html
npm run lint    # oxlint
```
Cutting a frontend change over to the served board is a copy:
`npm run build && cp -f dist/index.html ../index.html`.

## Architecture (full layout in CONTRIBUTING.md)

- `koreops.py` — the write door + resident **read / write / tap child processes**. Writes
  MUST run in the resident write agent: bridge keeps per-session locks in module globals, so
  a second process would stop serializing concurrent sends. File-browser reads/writes run a
  **fixed `python3 -I` script on the node** (`_FS_SCRIPT` / `_FS_WRITE_SCRIPT`); path policy
  (roots = session cwds + `$HOME`; deny `~/.ssh`, key files, `/proc`…) is enforced there,
  after `realpath`, because only the node knows what a symlink resolves to.
- `kore-bridge.py` — the engine; `sh(node_ip)` routes per node (self = local subprocess,
  else HTTP `/exec` on the client agent). Also an MCP-over-stdio server.
- `workbench/server.py` — dashboard HTTP server: serves one `index.html` + `/vendor/xterm`
  + the `/api/kore/*` read/write/fs endpoints (Bearer required for writes; `?token=` ok for
  reads/SSE).
- `workbench/web/` — the React dashboard; `vite-plugin-singlefile` inlines JS+CSS into one
  `index.html`, so the Python server stays unchanged (deploy = copy one file).

## Gotchas

- **A node command goes out as one `sh -c "<cmd>"` string → a single execve arg, capped at
  MAX_ARG_STRLEN (128 KiB), not the 2 MB total ARG_MAX.** The fixed fs-write script chunks
  uploads to stay under it (`kore.fs.put_chunk_bytes`, 48 KiB raw); never build a bigger
  single argument to `sh()`.
- The hyphenated scripts (`kore-bridge.py`, `kore-agent.py`) are run BY PATH, not imported —
  see CONTRIBUTING.md before renaming.
- `dispatch-allowlist.json` (`kore` section) IS the write policy — editing it is config, not
  code (CI validates it as JSON).
- Frontend is NOT cut over by the build alone: the served board uses `workbench/index.html`;
  update it by copying the fresh `dist/index.html` over.
