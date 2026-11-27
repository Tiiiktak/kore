// The path prefix the board is served under: '' at the root (the usual case), or e.g.
// '/gw/job/42/expose' when a reverse proxy mounts the board at a sub-path and strips that
// prefix before forwarding (https://gw/gw/job/42/expose/ -> board /). The board serves this
// one-file app at `/`, `/index.html` and `/s/<token>`, so whatever precedes those in the page
// URL is the prefix. Every request the app makes is root-relative, so all of them go through
// withBase() — otherwise /api, /ws and share links would hit the proxy's own root.
export const BASE = location.pathname
  .replace(/\/(index\.html|s\/[A-Za-z0-9_-]+\/?)?$/, '')
  .replace(/\/+$/, '')

export const withBase = (p: string): string => (p.startsWith('/') && !p.startsWith('//') ? BASE + p : p)
