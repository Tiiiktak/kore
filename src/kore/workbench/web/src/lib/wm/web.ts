// Browser-window proxy helpers: fetch a short-lived wview ticket and build the reverse-proxy
// URL. The proxied page runs CSP-sandboxed (opaque origin) on the board, so it can't read the
// dashboard token — the ticket is wview-only and expires (see server _wview_ticket).
import { apiGet } from '@/lib/api'

let ticket: { ticket: string; exp: number } | null = null

async function getTicket(): Promise<string> {
  if (ticket && ticket.exp * 1000 - Date.now() > 3600_000) return ticket.ticket
  const d = await apiGet<{ ticket: string; exp: number }>('/api/kore/wview-ticket')
  ticket = { ticket: d.ticket, exp: d.exp }
  return d.ticket
}

export async function proxyUrl(u: string): Promise<string> {
  const a = new URL(u)
  const b64 = btoa(a.protocol + '//' + a.host)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return (
    '/api/kore/wview/' + (await getTicket()) + '/' + b64 + '/' + a.pathname.replace(/^\//, '') + (a.search || '') + (a.hash || '')
  )
}

// "5173" / ":5173" -> http://localhost:5173 ; bare host -> http:// ; '' if unparseable.
export function normUrl(raw: string): string {
  let u = String(raw || '').trim()
  if (!u) return ''
  const port = u.match(/^:?(\d{2,5})(\/.*)?$/)
  if (port) u = 'http://localhost:' + port[1] + (port[2] || '')
  else if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  try {
    const x = new URL(u)
    return x.host ? x.href : ''
  } catch {
    return ''
  }
}
