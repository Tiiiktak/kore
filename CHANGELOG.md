# Changelog

All notable changes to **kore** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-10-23

### Fixed
- **Your own terminal was clipped after opening a session in the dashboard.** The
  browser resizes the far tmux window to fit its box, which makes tmux pin that window's
  `window-size` to `manual`; the "release" sent on close wrote `window-size latest`, a value
  tmux < 3.1 does not know, so the pin was never undone and `tmux attach` from a real
  terminal showed the browser's geometry. Now:
  - the window is released right after every resize by **unsetting** the window option
    (`set-option -w -u`), which restores the user's own tmux default on every version;
  - while a real terminal is attached, the browser does **not** resize the window at all —
    your terminal decides the size and the dashboard adapts to it.
- Already-pinned sessions can be released by hand with
  `tmux set-option -w -u -t <session> window-size`.

### Changed
- Broader tmux compatibility instead of hard requirements: typing from the dashboard falls
  back to `send-keys -l` where `send-keys -H` (tmux 3.0+) is missing, and on tmux < 2.9
  (no `resize-window`) the dashboard simply shows the window at its own size.
  `kore doctor` reports the tmux version and which feature degrades, as a warning.

## [0.3.1] — 2026-10-23

### Added
- **One-line install:** `curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh`.
  Needs only Python ≥ 3.8 and curl/wget (kore is stdlib-only — no pip, no uv). Installs the
  latest release under `~/.local/share/kore`, a `kore` launcher in `~/.local/bin`, and adds
  that dir to PATH when needed. Options: `--version vX.Y.Z`, `--no-modify-path`,
  `--uninstall`.
- `kore upgrade` recognizes an install.sh install and upgrades it by re-running the
  installer; it can find the latest release without git.

### Changed
- **Bare `kore` starts the server** (same as `kore server`) — install, then just run `kore`.
- The server banner prints the install one-liner next to the join command, for machines
  that don't have kore yet.

## [0.3.0] — 2026-10-23

Initial public release. kore manages Claude Code sessions running in tmux across one or
more machines, from a web dashboard or as MCP tools, with an explicit server/client model.

### Architecture
- **Explicit server/client model.** Start the central node with `kore server` — it is also
  a worker, so a single machine needs nothing else. Add machines with
  `kore client --server <ip:port> --token <tok>`. The engine routes **per node** with no
  switch and no configuration: the server's own host runs commands locally with
  `subprocess`, and every client is reached over HTTP through its stdlib agent.
- **Join by pasting a printed command.** `kore server` mints an agent token
  (`~/.kore/agent.token`, 0600) and prints a `kore client …` join line (k3s / tailscale
  style). A client reports in by POSTing its record to the server's register door every
  heartbeat; within the agent TTL its node appears in the roster. There is no shared-file
  registry and no assumption of shared storage.
- **Two token domains.** The WB token (browser ↔ dashboard, also the one-click share-link
  token) and the agent token (`KORE_AGENT_TOKEN`: server ↔ client, the client-join secret
  and the `/exec` fence) are separate. A browser token can never reach a node; an agent
  token can never drive a pane.
- **Stdlib only.** No third-party runtime dependencies.

### CLI
- Commands: `kore server`, `kore client`, `kore down`, `kore status`, `kore upgrade`,
  `kore mcp`, `kore ops`, `kore doctor`. Bare `kore` prints help.
- `kore server --restart` applies new config to a running board. `kore upgrade` updates in
  place (git clone fast-forward, or `uv tool` reinstall); `--version vX.Y.Z` pins a tag,
  `--check` only compares. For a private repo, export `KORE_GITHUB_TOKEN`.

### Dashboard
- **Multi-session tabs.** An OpenCode-style titlebar carries the kore wordmark, a
  horizontal session-tab strip, and a version pill. Opening a session from the roster adds
  a tab; several stay open and you switch between them. A pinned **Home** tab returns to the
  roster; **+** jumps to Home and expands the new-session form. One live terminal is reused
  (the `MAX_STREAMS` budget is unchanged). Per-tab close (×) detaches without killing;
  killing stays the explicit red button on the roster row.
- Live xterm.js terminal into any pane over SSE (keystrokes, resize, scroll), plus a
  low-latency byte stream (tmux control mode). Token-authed; every endpoint but
  `/api/health` requires the WB token, and writes additionally demand a Bearer header and a
  `confirm` that names the node + session.

### Packaging
- hatchling build, MIT license, console-script `kore`. GitHub Actions for CI (multi-version
  `py_compile`, the routing tests, a packaging smoke that installs the wheel and asserts the
  data files ship) and a tag-triggered Release that builds the wheel + sdist.

[0.3.2]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.2
[0.3.1]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.1
[0.3.0]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.0
