# Changelog

All notable changes to **kore** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.6] — 2026-10-26

### Added
- **Native tmux windows & panes.** A session is no longer pinned to its active pane. The status
  bar lists the session's tmux windows as clickable tabs; selecting a window with multiple panes
  mirrors the *whole* window — every pane laid out by tmux's own geometry — instead of a single
  pane. Split dividers are draggable (→ `tmux resize-pane`) with a live preview line. Overview
  cards surface each session's live command, cwd, and a "N 窗口 · N 分屏" badge.
- **tmux-style status bar** along the bottom of each terminal: session name, window tabs, clock.
- **Keyboard-driven tmux management (leader menu).** Press `⌃⇧A` over a focused terminal for a
  tmux-prefix-style menu — `c` new window, `s`/`v` split, `r` rename, `&` kill, `0–9` jump to a
  window. The same actions, with their shortcuts, are listed in the `⌘K` palette and the window
  title's switcher. All management runs through the audited write door as a new `manage` verb
  (window/pane are independently validated integer fields, never folded into the session name).

### Changed
- **One downleveled front-end for every browser.** The CSS that old in-app WebViews (如流 =
  Chrome 97) can't parse — `@layer`, `oklch()`, `color-mix()`, nesting — is now flattened at
  build time into the single shipped `index.html`. A modern browser renders it identically
  (verified side by side), so the previous modern/legacy split and the server-side UA sniffing
  are gone.
- **The mobile key row sits below the tmux status bar**, pinned to the soft keyboard, instead of
  under it.

## [0.5.5] — 2026-10-26

### Changed
- **New-window launcher redesign.** The empty-window picker is now a titled, left-aligned
  card: 终端/浏览器/文件 as a left tab bar, sectioned content, uniform control sizes, and
  ↑/↓ + Enter to open from the session list. It's top-anchored so switching tabs doesn't make
  it jump, and it rides up (instead of leaving a big blank) in a short pane such as the bottom
  of an up/down split. You can now start a session on a chosen machine even when the workspace
  has no sibling terminal — the old "回总览新建" dead-end is gone.
- **The window title is its own quick-switch popover.** Clicking a pane's title opens a slim
  switcher (already-open / same-machine sessions first, a filter, plus 网址 and 文件) instead
  of reusing the full launcher.
- **A workspace reads as one card.** Split panes are tiled inside a single rounded card
  divided by 1px hairline sashes (brighten on hover/drag), not separate cards with gaps; the
  per-pane active frame was dropped. Pane-header buttons now have theme-independent hover
  feedback, and the title / close hovers use iOS-style concentric corners at the card's
  corners.

### Added
- **Hover tooltips on non-obvious icons** via a small `Hint` wrapper over the shadcn Tooltip
  (instant). Universally understood icons (close, refresh…), text-labeled buttons, and touch
  controls are intentionally left without one.

### Fixed
- **`--bad-bg` was referenced but never defined**, so close / 结束 session / 关闭工作区 hovers
  silently fell back to grey instead of a soft red. Added the light/dark token and pointed
  those destructive controls at it.

## [0.5.4] — 2026-10-26

### Added
- **Upgrade & restart from the dashboard.** Settings shows the installed build with 检查更新
  (TTL-cached `GET /api/kore/latest`, proxy-aware) and a two-step 升级并重启. Each machine on
  the overview can be restarted or upgraded from a confirm popover — the server drives it on a
  client over the agent `/exec` fence with a fixed, `setsid`-detached command, WB-gated by a
  node-shaped `confirm` plus a `kore.node_actions` policy toggle and an audit row. A
  "重启中… → 已重启 ✓" badge watches the agent's `started_at` to confirm it really bounced.
  Pinned install / rollback and an **upgrade proxy** (for intranet nodes that can't reach
  github.com; saved to `~/.kore/config.json`, 0600) live under 设置 → 高级.
- **The overview is a dashboard.** Full-width, a KPI row (总会话 / 需回复 / 运行中 / 机器), a
  flat look (shadows dropped), flexible card columns with the session name emphasized and its
  original prefixed name shown, a terminal glyph in place of the colored tile, per-machine
  system metrics (负载 / 内存 / 磁盘 / GPU via a light `GET /api/kore/sysinfo` on its own
  cadence) and a "版本落后" badge. The whole page scrolls as one (mobile-friendly).
- **First-paint loader.** The HTML→JS gap now shows the brand mark with a pure-CSS pixel wave
  (and the themed background) instead of a white flash; torn down when React mounts.
- **Favicon + a shared `BrandMark`.** The brand mark is one component reused by the top-bar
  logo (hover sweep), the terminal connecting loader, and the favicon.
- **Split button hovers open.** Hovering a window's split button floats out 左右/上下分屏
  (no click needed); a direction that lacks room is disabled.
- **The new-window picker follows the workspace.** When the workspace already holds a
  terminal, the empty-window picker shows a "联动 ‹session›·‹机器›" banner and leans toward
  it: same-machine sessions first, a "在 ‹机器› 新建会话" shortcut (started in the sibling
  terminal's current directory and filled into the window once it appears), and the files tab
  defaults to that machine with an "打开当前终端目录" shortcut. The current directory comes
  from the session's live `pane_current_path` (via the fs roots), not the stale create-time
  value.

### Fixed
- **"需要你" was laggy.** The dashboard polled the 120s-cached cluster roster, so a waiting
  session could take ~2 min to light up — worse for client sessions, which keep no hook file
  and rely on the pane scraper that only runs inside that scan. The cluster sweep is ~0.25s on
  a healthy fleet, so its TTL is now 6s (was 120s) and the poll 6s (was 10s): "需要你" surfaces
  within seconds for every session.
- **An actively-working session could show idle.** A frozen hook record (stuck at
  `SessionStart`) was trusted over a clearly-busy pane; the scraper may now correct a stale
  `idle → busy` (in addition to the existing `idle → waiting` menu upgrade).
- **Agent restart was invisible.** The register door read `started_at` / `pid` but never
  stored them, and a "preserve" line pinned the first value — so a restart could never be
  confirmed. They are stored now and the agent's reported value is trusted (last-known only as
  a fallback), which also drives the overview's restart confirmation and version column.
- **Terminal recovery.** A tap drop after data (a server/agent restart) now re-subscribes with
  backoff instead of freezing on "对面结束了", and the version string rides the roster poll so
  it refreshes itself after an upgrade+restart.
- **"需要你" didn't clear when handled.** Opening a waiting session, or typing into it, now
  optimistically clears its blink until the next roster read reconciles.
- **tmux target matched by prefix.** `has_session` used `tmux has-session -t <name>`, which
  matches by PREFIX — so creating `kore-test` was wrongly refused as "already exists" (it hit
  an existing `kore-test-hook`), and `send`/`stop` could act on the wrong session. Now an
  exact `-t =<name>` target (with a regression test).
- A failed `start` (name taken, node unreachable, …) now surfaces its real error in the
  new-window picker instead of hanging silently on "启动中…".

## [0.5.3] — 2026-10-25

### Added
- **Motion pass.** State changes animate instead of hard-cutting: overview↔session
  cross-fade (the stage eases in), a window scale-fades in when opened, workspace tabs and
  status dots transition their colours, and the top↔left tab-bar switch eases its nav in.
  Everything is ≤240ms and disabled under `prefers-reduced-motion`.

### Fixed
- Closing a workspace's last window now returns to the overview (or the next workspace)
  instead of leaving an empty "new window" page in place.

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
