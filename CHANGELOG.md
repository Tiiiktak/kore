# Changelog

All notable changes to **kore** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] — 2026-10-25

### Added
- **Terminal connecting animation.** While a pane connects, the terminal shows the kore
  brand mark with a diagonal "pixel wave" (each sub-pixel breathes offset by its position,
  looping a light sweep across the mark), a Claude-tint glow, and a faint "Connecting…" —
  instead of a blank dark box. Delayed 0.3s so a fast local connect never flashes it, and
  torn down on the first real frame.

## [0.5.1] — 2026-10-25

### Added
- **New dashboard frontend.** The hand-written single-file board was rebuilt as a
  React + TypeScript + Tailwind + shadcn/ui app, still served as one self-contained
  `index.html` (deploy stays a copy). It brings a multi-window workspace (split
  terminals / browser / files), an xterm terminal over a multiplexed WebSocket (with the
  SSE feed as fallback), a reverse-proxy **browser window** (scoped, expiring wview ticket;
  the proxied page runs CSP-sandboxed), a ⌘K command palette, and a mobile layout.
- **File browser.** Browse a node's session cwds + `$HOME` (lazy tree, syntax-highlighted
  preview) and manage files: new folder, rename, delete (hard `rm`, two-step confirm),
  unlimited chunked upload, download, and image preview. All path policy is enforced on the
  node by a fixed `python3 -I` sandbox script — never leaves the session roots / `$HOME`,
  refuses `~/.ssh`, `~/.kore`, key/token files and `/proc`,`/sys`,`/dev`. Every write runs
  through the same write-agent + audit pipeline as the tmux verbs (gated by `kore.fs` in the
  allowlist), keyed by path.
- **Add existing tmux sessions.** `kore adopt` lists the tmux sessions on this machine that
  do not carry the prefix; `kore adopt <name>` (or `--all`) renames them into it
  (`work` → `kore-work`) — the programs inside keep running and attached terminals stay
  attached. The dashboard's **+ 已有 session** does the same for every machine (server and
  clients), through the gated `adopt` write (`POST /api/kore/adopt`, audited like other
  writes) and the read-only `GET /api/kore/unmanaged`.
- **One tab per machine** above the session list ("全部" plus each node), remembered per
  browser; the node count pill now only appears when something is wrong.
- The dashboard remembers its layout across reloads: open session tabs and the active one
  (reopened if it still exists), top/left tab bar, the selected machine tab.

### Changed
- Session icons are the Claude Code logo in white (drawn as exact SVG pixels, truly
  centered) on a colored tile picked from the session name; machines have no icon, and their
  nickname is edited by clicking the machine name. The custom fruit/animal icon set is gone.
- The brand mark (top-left) and the browser favicon are one vector SVG — square, crisp,
  theme-aware (`--claude`); the tab-side toggle sits to the right of the "kore" wordmark.
- No element is outlined on just one side (separators became spacing or tinted blocks) —
  an owner design rule the new frontend carries forward.

## [0.5.0] — 2026-10-23

### Added
- **Sessions are grouped by machine.** Each node gets a header — `server` (this host) or
  `client`, its name, hostname, IP and session count — and its own color as a stripe on
  every row and as a ring around the session's icon in the tabs. Machines that have joined
  but have no sessions yet are listed too.
- **Icons and nicknames.** A set of small 2-line ASCII icons (fruits and animals, drawn
  with the same quadrant block characters as the kore logo) on a light background. Every
  session and machine gets one automatically from its name (FNV-1a hash → icon + background,
  the same on every device). Click the icon to set a nickname and/or pick another icon;
  labels are stored on the server (`~/.kore/labels.json`, `POST /api/labels`), so every
  device shows the same names. Tabs, the terminal title and the node picker use them.
- **Tabs on the top or on the left.** A button at the top right moves the session tabs into
  a left sidebar and back (remembered per browser). Wide screens only; phones keep the top bar.

## [0.4.1] — 2026-10-23

### Fixed
- **The dashboard titlebar showed `v?`.** server.py runs as a script, where the `kore`
  package is importable only when installed into site-packages (`uv tool`), so from a clone
  or an install.sh install the version import failed and fell back to `?`. The version is
  now read from the package's `__init__.py` by path; a test guards it.

## [0.4.0] — 2026-10-23

### Added
- **"+ 添加机器" in the dashboard.** Shows the install line and the exact `kore client …`
  join line (each with a copy button), the network requirements, and every machine that has
  joined: online / offline / joined-but-unreachable, with the reason. Backed by a new
  read-only `GET /api/join` (WB token).

### Changed
- **`kore client` runs in the background** and only returns once the server has accepted
  the machine. Before starting anything it checks that the server is reachable and that the
  token is right (a typo never stops a working client), then waits for the first
  registration and reports whether the server can connect back to this machine's agent.
  `--foreground` keeps the old attached behaviour.
- `kore status` / `kore down` cover both roles on a machine (server and/or client).
- The client agent listens on a **fixed default port, 8199** (falls back to a free port when
  taken), so the firewall rule for "server → client" is predictable.
- Runtime files are per host (`server-<host>.pid`, `client-<host>.log`, …): `~/.kore` is often
  on shared storage, and a pid written on one machine must never be signalled from another.

### Fixed
- **A client could silently fail to join or drop out.** The agent crashed if the very first
  registration failed, kept retrying a rejected token forever, ran only while its terminal
  stayed open, and never learned that the server could not reach it back. Each of these is
  now reported (and a rejected token stops the agent).
- The server probes a client's agent when it registers (`reachable` in the reply), so
  "joined but unreachable" is visible in the CLI and the dashboard.

## [0.3.5] — 2026-10-23

### Changed
- The mobile input-box toggle is a simple, larger line keyboard icon (rounded frame, one
  row of key dots, a space bar) instead of the pencil from 0.3.4.

## [0.3.4] — 2026-10-23

### Changed
- The mobile input-box toggle is a larger icon instead of the ⌨ glyph.
- `kore doctor` adds a non-warning note on tmux 3.0.x: fine for kore, while 3.1+ is nicer
  when one session is attached from several terminals at once.

### Fixed
- Tapping **Ctrl** in the mobile key bar highlighted the input-box toggle instead of Ctrl
  (the Ctrl state lookup matched the first modifier-styled button).

## [0.3.3] — 2026-10-23

### Changed
- **The window follows whoever is using it.** v0.3.2 made an attached terminal always win,
  which left the dashboard stuck at the terminal's size. Now, while the dashboard has focus
  it fits the window to the browser; when it loses focus (you switch to your own
  `tmux attach`, another window or tab) the window is released to tmux and your terminal
  gets its size back; returning to the dashboard fits it again. Emulates tmux 3.1's
  `window-size latest` on every version (release = `set-option -w -u`).
- **Mobile input box appears on demand.** The native compose box (for IME / voice input) is
  hidden by default; tap the terminal or the new ⌨ key in the key bar to show it. It hides
  itself when it loses focus while empty (a half-written draft stays).

### Added
- **tmux upgrade guidance.** `kore doctor` warns when tmux is older than 3.0, says which
  feature degrades, and prints upgrade commands for this machine (apt / dnf / yum / apk /
  pacman / zypper / Homebrew, conda-forge when available, or building from source). `kore`
  prints a one-line note at startup on an old tmux. Old tmux still works — this is guidance,
  not a requirement.

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

[0.5.0]: https://github.com/Tiiiktak/kore/releases/tag/v0.5.0
[0.4.1]: https://github.com/Tiiiktak/kore/releases/tag/v0.4.1
[0.4.0]: https://github.com/Tiiiktak/kore/releases/tag/v0.4.0
[0.3.5]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.5
[0.3.4]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.4
[0.3.3]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.3
[0.3.2]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.2
[0.3.1]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.1
[0.3.0]: https://github.com/Tiiiktak/kore/releases/tag/v0.3.0
