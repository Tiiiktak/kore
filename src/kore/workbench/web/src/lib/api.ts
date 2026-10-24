// The one read/write client against the kore board, ported from the old board's apiGet/kPost.
// Auth: reads send Authorization: Bearer <token> (server also accepts ?token=), writes REQUIRE
// the Bearer header (never ?token=). Token comes from the page URL ?token=, same as before.

export const TOKEN = new URLSearchParams(location.search).get('token') || ''

const authHeaders = (): Record<string, string> =>
  TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store', headers: authHeaders() })
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }))
  if (!r.ok) throw new Error((d as any).refused || (d as any).error || 'HTTP ' + r.status)
  return d as T
}

// The live tmux prefix (from the roster). Writes must name their target with a `confirm` that
// equals `<verb>:<node_ip>:<full_name>`, and full_name prefixes the name iff not already
// prefixed (koreops.full_name). Defaults to 'kore-'; set from the roster so it can't drift.
let korePrefix = 'kore-'
export const setKorePrefix = (p?: string) => {
  if (p) korePrefix = p
}
const fullName = (name: string) => (name.startsWith(korePrefix) ? name : korePrefix + name)

// Writes: POST /api/kore/<verb> with a Bearer header and a `confirm` that names the target.
export async function kPost<T = unknown>(
  verb: string,
  body: Record<string, unknown>,
): Promise<T> {
  const confirm =
    typeof body.node_ip === 'string' && typeof body.name === 'string'
      ? `${verb}:${body.node_ip}:${fullName(body.name)}`
      : undefined
  const r = await fetch('/api/kore/' + verb, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(confirm !== undefined ? { ...body, confirm } : body),
  })
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }))
  if (!r.ok) throw new Error((d as any).refused || (d as any).error || 'HTTP ' + r.status)
  return d as T
}

// ---- file-browser writes (Phase 2) -----------------------------------------------------
// A separate door from kPost: the target is a PATH, not a tmux session, so the server keys
// `confirm` and the audit by path. `op` is the URL route (upload is the chunked `put`).
export type FsWriteOp = 'mkdir' | 'rename' | 'delete' | 'upload'

export async function kFsWrite<T = unknown>(
  op: FsWriteOp,
  body: { node_ip: string; path: string } & Record<string, unknown>,
): Promise<T> {
  const confirm = `fs-${op}:${body.node_ip}:${body.path}`
  const r = await fetch('/api/kore/fs/' + op, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ...body, confirm }),
  })
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }))
  if (!r.ok) throw new Error((d as any).refused || (d as any).error || 'HTTP ' + r.status)
  return d as T
}

export interface ReadBResp {
  ok: boolean
  data: string // base64 of this range
  len: number
  size: number
  offset: number
  eof: boolean
  error?: string
}

// One byte range of a file as base64. The caller loops on offset to pull any size.
export async function kFsReadB(
  nodeIp: string,
  path: string,
  offset: number,
  len: number,
): Promise<ReadBResp> {
  const qs =
    'node_ip=' +
    encodeURIComponent(nodeIp) +
    '&path=' +
    encodeURIComponent(path) +
    '&offset=' +
    offset +
    '&len=' +
    len
  return apiGet<ReadBResp>('/api/kore/fs/readb?' + qs)
}

// Token appended for transports that cannot set a header (EventSource / WebSocket).
export const withToken = (path: string): string =>
  TOKEN ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : path

// Display label (rename) for a node or session — POST /api/labels. Empty name clears it.
export async function setLabel(kind: 'node' | 'session', key: string, name: string): Promise<void> {
  const r = await fetch('/api/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kind, key, name, icon: '' }),
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error((d as any).error || 'HTTP ' + r.status)
  }
}
