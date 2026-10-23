"""kore — manage kore sessions (Claude Code in tmux across machines) from a web
dashboard or as MCP tools, with an explicit server/client model.

A single machine runs `kore server` (which is also a worker); extra machines join with
`kore client --server <ip:port> --token <tok>`. The engine routes per node: the server's
own host runs commands locally, every client is reached over HTTP through its agent.

This package is a thin CLI (`kore.cli`) over a set of self-contained scripts that
are shipped as package data and run by path, not imported as modules:

  * koreops.py            — the single write door + resident write/read/tap children
  * kore-bridge.py     — the engine, also an MCP-over-stdio server
  * kore-agent.py         — per-node HTTP agent run on a client: /exec /tap /ping
  * workbench/server.py — the HTTP dashboard + SSE terminal server

See `kore.cli` for the subcommand dispatch (server/client/mcp/ops/doctor).
"""

__version__ = "0.5.0"
