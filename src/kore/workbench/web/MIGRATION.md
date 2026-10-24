# kore web — shadcn/ui migration (hybrid, incremental)

New frontend: Vite + React 19 + TS + Tailwind v4 + shadcn/ui (`style: radix-nova`,
lucide icons). Replaces the hand-written single-file `../index.html` **surface by surface**.
The old board keeps serving live until the React app reaches parity, then we cut over.

## Why it doesn't change the server
`vite-plugin-singlefile` inlines all JS+CSS into ONE `dist/index.html`. The Python board
server keeps serving a single `index.html` with zero changes; deploy stays a `cp`.

## Dev
    cd src/kore/workbench/web
    npm run dev          # Vite HMR on :8290, proxies /api,/ws,/vendor -> board :8198 (real backend)
    # live preview: http://<host>:8290/?token=<wb.token>  (8199 is taken by kore-agent)

## Build + deploy (only when cutting a surface over)
    npm run build        # -> dist/index.html (one self-contained file)
    # preview: open dist/index.html; cut over by copying to the served board:
    # command cp -f dist/index.html ../index.html   # (NOT done yet — parity first)
    # then install to the live board as usual.

## Network / proxy (Baidu internal host)
- npm registry: configured in ~/.npmrc (proxy=yy). Plain `npm i` works.
- shadcn CLI fetches ui.shadcn.com with its OWN client (ignores ~/.npmrc). Prefix every
  shadcn command with the proxy env:
    HTTPS_PROXY="http://yy:...@10.251.112.49:8207" HTTP_PROXY="..." no_proxy="" NO_PROXY="" npx shadcn@latest add <c>
- Do NOT use shadcn's `init --template vite` here: it git-clones shadcn-ui/ui (proxy chokes).
  Scaffold with `npm create vite` first, then `shadcn init` in the existing project.

## Engine ported as imperative TS (mounted by React via refs), NOT rewritten in React:
xterm terminal lifecycle, kWS WebSocket multiplex + SSE fallback, multi-window split-tree
manager, reverse-proxy browser window, file browser, mobile compose box.

## Progress (2026-10-25)
DONE: app shell + theme tokens; overview (real roster, filter chips, status, stars);
terminal engine (xterm6 + kWS + SSE fallback + geometry + copy) as TS, mounted by React;
multi-window stage (workspace tabs with split-state labels, split/close/sash, focus ring,
launcher with term/web/files + dedup, title Switch popover); browser window (proxy + ticket);
file window (roots/list/read). Dev server: 8290, HMR, proxies to board 8198 (real backend).
Single-file prod build ~1.07MB/350KB gz.

DONE also: ⌘K command palette (plain Dialog, no cmdk); full settings (theme/renderer/font, live);
sidebar/top tab-bar toggle; density pass (14px root + system font); mobile — single-window stage +
window switcher + terminal key bar; focus-visible + reduced-motion quality floor.

DONE also: unified StatusDot (green=busy/grey=idle/yellow-flash=waiting) on cards + workspace tabs
+ overview needs-you badge; overview = machine-grouped card grid w/ status summary; session
lifecycle — new session dialog, two-step end-session, add-machine (join), adopt existing,
rename (labels) for sessions + machines.

REMAINING: optional color restraint pass; empty/error states as directive Empty; machine chip
status filter; cut over (replace served index.html + its index.html-reading tests).

## Migration order (chrome first, engine wrapped last)
1. App shell + theme (tokens mapped from old `:root`) + topbar/workspace tabs.
2. Overview (session list, machine filter, row menus) — shadcn.
3. Settings dialog, launchers, command palette (⌘K) — shadcn Dialog/Command/DropdownMenu.
4. Port terminal + multi-window engine as TS modules mounted into React containers.
5. Browser + file windows. 6. Mobile. 7. Cut over + replace index.html-reading tests.
