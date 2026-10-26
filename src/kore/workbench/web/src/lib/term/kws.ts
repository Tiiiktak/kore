// One WebSocket multiplexing every terminal's (read-only) byte stream, ported from the old
// board's kWS. Each frame carries an `id` naming which terminal it belongs to. Reads only:
// the client sends sub/unsub; the server attaches a `tmux -C attach -r`. Writes go through
// kPost (Bearer + confirm), never here. Auth = ?token= on the /ws URL (proxied to the board).
import { TOKEN } from '@/lib/api'

export interface KwsHandlers {
  prime?: (m: any) => void
  hello?: (m: any) => void
  geom?: (m: any) => void
  out?: (m: any) => void
  err?: (m: any) => void
  end?: (m: any) => void
  _down?: () => void
  _up?: () => void
  node_ip?: string
  name?: string
  window?: number // optional tmux window index (undefined = the session's active window)
  pane?: number // optional tmux pane index within window (undefined = that window's active pane)
}

function makeKws() {
  let ws: WebSocket | null = null
  let connected = false
  let backoff = 500
  let timer: ReturnType<typeof setTimeout> | null = null
  const subs = new Map<string, KwsHandlers>()

  const wsUrl = () =>
    (location.protocol === 'https:' ? 'wss:' : 'ws:') +
    '//' +
    location.host +
    '/ws' +
    (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '')

  function connect() {
    if (ws) return
    let sock: WebSocket
    try {
      sock = new WebSocket(wsUrl())
    } catch {
      schedule()
      return
    }
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      connected = true
      backoff = 500
      for (const [id, h] of subs) {
        rawsend({ t: 'sub', id, node_ip: h.node_ip, name: h.name, window: h.window, pane: h.pane })
        h._up?.()
      }
    }
    sock.onmessage = (ev) => {
      let m: any
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if (!m || typeof m.id !== 'string') return
      const h = subs.get(m.id)
      const fn = h && (h as any)[m.t]
      if (typeof fn === 'function') {
        try {
          fn(m)
        } catch {
          /* ignore handler throw */
        }
      }
    }
    const dropped = () => {
      if (ws !== sock) return
      ws = null
      connected = false
      for (const [, h] of subs) h._down?.()
      schedule()
    }
    sock.onclose = dropped
    sock.onerror = dropped
  }

  function schedule() {
    if (timer || !subs.size) return
    timer = setTimeout(() => {
      timer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, 8000)
  }

  function rawsend(obj: unknown): boolean {
    if (ws && connected) {
      try {
        ws.send(JSON.stringify(obj))
        return true
      } catch {
        /* fallthrough */
      }
    }
    return false
  }

  return {
    connected: () => connected,
    sub(id: string, node_ip: string, name: string, handlers: KwsHandlers) {
      handlers.node_ip = node_ip
      handlers.name = name
      subs.set(id, handlers)
      connect()
      rawsend({ t: 'sub', id, node_ip, name, window: handlers.window, pane: handlers.pane })
    },
    unsub(id: string) {
      if (subs.delete(id)) rawsend({ t: 'unsub', id })
    },
  }
}

export const kws = makeKws()
