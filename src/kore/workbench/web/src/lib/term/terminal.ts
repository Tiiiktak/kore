// Per-window terminal engine — a faithful TS port of the old board's makeTermWin.
// Bytes-first via the kWS multiplex, with a first-frame watchdog that falls back to the SSE
// screen feed; input via kPost (Bearer + confirm); geometry fitted to the box by asking the
// backend to resize the tmux window; copy-on-selection; mouse-tracking swallowed so native
// selection works. The engine is imperative and framework-free — React just mounts it.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { kPost, TOKEN } from '@/lib/api'
import { kws } from './kws'
import { fontGet, wantsWebgl } from './settings'

const COLS_MIN = 20
const COLS_MAX = 400
const ROWS_MIN = 5
const ROWS_MAX = 200
const PASTE_MAX = 2048

export interface TermSession {
  node_ip: string
  name: string
  writable: boolean
}
export interface KoreTerminal {
  focus(domFocus?: boolean): void
  blur(): void
  fit(): void
  reload(): void
  setFont(px: number): void
  applyRenderer(): void
  send(data: string): void
  setCtrl(on: boolean): void
  dispose(): void
}

// Live terminals, so a settings change (font / renderer) can broadcast to all of them.
const registry = new Set<KoreTerminal>()
export function broadcastTerminalSettings() {
  for (const t of registry) {
    t.setFont(fontGet())
    t.applyRenderer()
  }
}

interface Frame {
  kind: 'full' | 'rows'
  text?: string
  dirty?: Array<[number, string]>
  scroll?: number
  cols: number
  rows: number
  cx: number
  cy: number
  cvis: boolean
  state?: string
  prime?: boolean
}

// Material-ish theme on a near-black bg (terminals stay dark regardless of app theme).
const THEME = {
  background: '#212121', foreground: '#EEFFFF', cursor: '#FFCB6B', cursorAccent: '#000000',
  selectionBackground: '#2f5d8a', selectionForeground: '#ffffff',
  black: '#000000', red: '#FF5370', green: '#C3E88D', yellow: '#FFCB6B', blue: '#82AAFF',
  magenta: '#C792EA', cyan: '#89DDFF', white: '#ffffff',
  brightBlack: '#4A4A4A', brightRed: '#FF5370', brightGreen: '#C3E88D', brightYellow: '#FFCB6B',
  brightBlue: '#82AAFF', brightMagenta: '#C792EA', brightCyan: '#89DDFF', brightWhite: '#ffffff',
}

function harden(term: Terminal, copy: () => void) {
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    if ((ev.key || '').toLowerCase() !== 'c' || !(ev.ctrlKey || ev.metaKey)) return true
    if (!ev.shiftKey && !term.hasSelection()) return true
    copy()
    return false
  })
  const MODES = new Set([1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016])
  const swallow = (params: (number | number[])[]) => {
    let hit = false
    for (const p of params) {
      const n = Array.isArray(p) ? p[0] : p
      if (MODES.has(n)) hit = true
      else return false
    }
    return hit
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, swallow as any)
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, swallow as any)
}

function copySelection(term: Terminal, say: (m: string) => void) {
  const text = term.getSelection()
  if (!text) return
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.appendChild(ta)
  let ok = false
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  try {
    term.focus()
  } catch {
    /* ignore */
  }
  if (ok) say('已复制 ' + text.length + ' 字')
  else if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(text).then(
      () => say('已复制 ' + text.length + ' 字'),
      () => say('复制失败'),
    )
  else say('复制失败')
}

export function createKoreTerminal(
  host: HTMLElement,
  session: TermSession,
  say: (m: string) => void,
  winId: string,
  onCtrl: (on: boolean) => void = () => {},
  onReady: () => void = () => {},
): KoreTerminal {
  const s = session
  const id = winId + '|' + s.node_ip + '/' + s.name

  let fit: FitAddon | null = null
  let webgl: WebglAddon | null = null
  let stream: { kind: 'ws'; id: string } | EventSource | null = null
  let wire: '' | 'bytes' | 'screen' | 'text' = ''
  let far: { cols: number; rows: number } | null = null
  let farSure = false
  let tapFresh = false
  let got = 0
  let downs = 0
  let wdog: ReturnType<typeof setTimeout> | 0 = 0
  let queue: string[] = []
  let sending = false
  let geomAsked = ''
  let geomBusy = false
  let borrowed = false
  let focused = false
  let disposed = false
  let ctrlArmed = false
  // Fired once, the first time real content paints (first tap byte, or the first non-prime
  // frame). The loading overlay lives in TerminalView and is torn down on this — same idea as
  // the old board unveiling #c-pane-loading when the first byte arrived.
  let readyFired = false
  const markReady = () => {
    if (readyFired) return
    readyFired = true
    try {
      onReady()
    } catch {
      /* ignore */
    }
  }

  const term = new Terminal({
    convertEol: true,
    cursorBlink: false,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    disableStdin: true,
    scrollback: 2000,
    fontSize: fontGet(),
    fontFamily: 'Monaco, Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    fontWeight: 400,
    fontWeightBold: 600,
    theme: THEME,
  })

  function boxDims() {
    if (!fit || !host.clientHeight) return null
    const p = fit.proposeDimensions()
    if (!p || !Number.isFinite(p.cols) || !Number.isFinite(p.rows)) return null
    return {
      cols: Math.max(COLS_MIN, Math.min(COLS_MAX, Math.floor(p.cols))),
      rows: Math.max(ROWS_MIN, Math.min(ROWS_MAX, Math.floor(p.rows))),
    }
  }
  const localGeom = () => (farSure && far ? far : boxDims() || far)

  function setGeom(g: { cols: number; rows: number } | null) {
    if (!g) return
    if (term.cols !== g.cols || term.rows !== g.rows) term.resize(g.cols, g.rows)
    const box = boxDims()
    host.classList.toggle('scroll', !!box && (g.cols > box.cols || g.rows > box.rows))
  }

  function fitGeom() {
    if (!far || !s.writable) return
    const box = boxDims()
    if (!box) return
    const key = box.cols + 'x' + box.rows
    if (box.cols === far.cols && box.rows === far.rows) return
    if (geomBusy || key === geomAsked) return
    geomAsked = key
    geomBusy = true
    borrowed = true
    kPost('resize', { node_ip: s.node_ip, name: s.name, cols: box.cols, rows: box.rows })
      .catch((e: Error) => {
        geomAsked = ''
        say('贴合失败（可滚动看全）：' + e.message)
      })
      .finally(() => {
        geomBusy = false
      })
  }
  function release() {
    const box = boxDims() || far
    geomAsked = ''
    if (!borrowed || !box || !s.writable) {
      borrowed = false
      return
    }
    borrowed = false
    kPost('resize', { node_ip: s.node_ip, name: s.name, cols: box.cols, rows: box.rows, auto: true }).catch(() => {})
  }

  function applyTerm(f: Frame) {
    const cols = Math.max(2, f.cols | 0)
    const rows = Math.max(2, f.rows | 0)
    far = { cols, rows }
    if (!f.prime) farSure = true
    setGeom(localGeom())
    let out = '\x1b[?25l'
    if (f.kind === 'full') {
      term.reset()
      out += f.text || ''
    } else {
      const k = Math.max(0, Math.min(rows, f.scroll! | 0))
      if (k) out += `\x1b[m\x1b[${rows};1H` + '\n'.repeat(k)
      for (const row of f.dirty || []) out += `\x1b[m\x1b[${(row[0] | 0) + 1};1H${row[1]}\x1b[K`
    }
    out += `\x1b[m\x1b[${(f.cy | 0) + 1};${(f.cx | 0) + 1}H`
    term.write(out + (f.cvis ? '\x1b[?25h' : ''))
    if (f.kind === 'full') fitGeom()
    say(f.state || '')
    if (!f.prime) markReady() // a real frame (screen feed / echo) — not the "连接中" placeholder
  }

  const echoable = (d: string) => typeof d === 'string' && !!d && !/[\u0000-\u001f\u007f]/.test(d)

  function ctrlify(str: string): string {
    if (!str) return str
    const c = str.codePointAt(0)!
    let cc = -1
    if (c >= 97 && c <= 122) cc = c - 96 // a-z -> ^A..^Z
    else if (c >= 64 && c <= 95) cc = c - 64 // @A-Z[\]^_ -> 0x00..0x1f
    else if (c === 63) cc = 127 // ? -> DEL
    return cc >= 0 ? String.fromCharCode(cc) + str.slice(1) : str
  }
  function input(data: string) {
    if (!focused || !s.writable || typeof data !== 'string' || !data) return
    if (ctrlArmed) {
      data = ctrlify(data)
      ctrlArmed = false
      onCtrl(false)
    }
    const cps = [...data]
    if (cps.length > PASTE_MAX) {
      say(`一批 ${cps.length} 字符超上限 ${PASTE_MAX}`)
      return
    }
    if (wire === 'screen' && echoable(data)) term.write(data)
    for (const ch of cps) queue.push(ch.codePointAt(0)!.toString(16))
    flush()
  }
  function flush() {
    if (sending || !queue.length || !s.writable || !focused) return
    const batch = queue.splice(0, 256)
    sending = true
    const tap = wire === 'bytes'
    kPost<any>('input', {
      node_ip: s.node_ip,
      name: s.name,
      hex: batch.join(' '),
      ...(tap ? { echo: false } : {}),
    })
      .then((d) => {
        if (!tap) {
          echo(d)
          return
        }
        if (!d.ok) say('按键没落下去：' + (d.error || ''))
      })
      .catch((e: Error) => {
        queue = []
        if (wire !== 'bytes') resub()
        say('按键被拒：' + e.message)
      })
      .finally(() => {
        sending = false
        if (queue.length) flush()
      })
  }
  function echo(d: any) {
    if (!d || !d.ok) {
      resub()
      return
    }
    applyTerm({
      kind: 'rows',
      dirty: String(d.output || '')
        .split('\n')
        .map((ln: string, i: number) => [i, ln] as [number, string]),
      cols: d.cols,
      rows: d.rows,
      cx: d.cursor_x,
      cy: d.cursor_y,
      cvis: d.cursor_vis,
      state: d.state,
    })
  }

  function subscribe() {
    unsub()
    got = 0
    downs = 0
    tapFresh = true
    wire = 'bytes'
    farSure = false
    far = null
    if (typeof WebSocket !== 'function') {
      subScreen()
      return
    }
    stream = { kind: 'ws', id }
    const seen = () => {
      if (wdog) {
        clearTimeout(wdog)
        wdog = 0
      }
    }
    const fallback = (msg: string) => {
      seen()
      kws.unsub(id)
      stream = null
      subScreen()
      say(msg)
    }
    wdog = setTimeout(() => {
      if (!got && stream && (stream as any).id === id) fallback('实时流无数据，退回抓屏')
    }, 4000)
    const geom = (m: any) => {
      seen()
      far = { cols: Math.max(2, m.cols | 0), rows: Math.max(2, m.rows | 0) }
      farSure = true
      setGeom(localGeom())
      fitGeom()
    }
    kws.sub(id, s.node_ip, s.name, {
      prime: (d) => {
        seen()
        if (got) return
        applyTerm({ kind: 'full', text: d.text || '', cols: d.cols, rows: d.rows, cx: d.cx, cy: d.cy, cvis: true, state: d.state || '连接中…', prime: true })
      },
      hello: geom,
      geom,
      out: (d) => {
        seen()
        const raw = atob(d.b64 || '')
        if (!raw) return
        const u8 = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i) & 0xff
        if (tapFresh) {
          tapFresh = false
          term.reset()
          say('')
        }
        got += u8.length
        term.write(u8)
        markReady()
      },
      err: (m) => {
        if (stream && (stream as any).id === id) {
          if (!got) {
            fallback('字节流起不来，退回抓屏：' + (m.error || ''))
            return
          }
          kws.unsub(id)
          stream = null
          say('对面结束了：' + (m.error || ''))
        }
      },
      end: () => {
        if (stream && (stream as any).id === id && !got) fallback('字节流中断，退回抓屏')
      },
      _down: () => {
        if (!(stream && (stream as any).id === id)) return
        tapFresh = true
        downs += 1
        if (!got && downs >= 3) {
          fallback('实时流连不上，退回抓屏')
          return
        }
        say('断线重连中…')
      },
      _up: () => {
        tapFresh = true
      },
    })
  }
  function subScreen() {
    wire = 'screen'
    const url =
      `/api/kore/stream?node_ip=${encodeURIComponent(s.node_ip)}&name=${encodeURIComponent(s.name)}&lines=400&mode=term` +
      (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '')
    const es = new EventSource(url)
    stream = es
    es.addEventListener('term', (ev) => applyTerm(JSON.parse((ev as MessageEvent).data)))
    es.addEventListener('err', () => say('读取失败'))
    es.onerror = () => say('断线重连中…')
  }
  function unsub() {
    if (wdog) {
      clearTimeout(wdog)
      wdog = 0
    }
    if (stream) {
      if ((stream as any).kind === 'ws') kws.unsub((stream as any).id)
      else (stream as EventSource).close()
      stream = null
    }
    wire = ''
  }
  function resub() {
    subscribe()
  }

  // --- mount ---
  term.open(host)

  // Mobile touch scroll: xterm's scrollable viewport sits UNDER the screen layer, so a finger
  // drag never scrolls the scrollback natively. Translate single-finger vertical drags into
  // scrollLines. A near-stationary touch stays a tap (whose click opens the compose box
  // upstream), so only a real drag scrolls and swallows the gesture.
  let touchY: number | null = null
  let touchAccum = 0
  let touchMoved = false
  const cellPx = () => (term.rows ? host.clientHeight / term.rows : 0) || 18
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return void (touchY = null)
    touchY = e.touches[0].clientY
    touchAccum = 0
    touchMoved = false
  }
  const onTouchMove = (e: TouchEvent) => {
    if (touchY === null || e.touches.length !== 1) return
    const y = e.touches[0].clientY
    touchAccum += y - touchY
    touchY = y
    if (!touchMoved && Math.abs(touchAccum) < 6) return // small wobble stays a tap
    touchMoved = true
    const h = cellPx()
    const lines = Math.trunc(touchAccum / h)
    if (lines !== 0) {
      term.scrollLines(-lines) // drag down → reveal earlier scrollback
      touchAccum -= lines * h
    }
    if (e.cancelable) e.preventDefault()
  }
  const endTouch = () => void (touchY = null)
  host.addEventListener('touchstart', onTouchStart, { passive: true })
  host.addEventListener('touchmove', onTouchMove, { passive: false })
  host.addEventListener('touchend', endTouch, { passive: true })
  host.addEventListener('touchcancel', endTouch, { passive: true })
  const teardownTouch = () => {
    host.removeEventListener('touchstart', onTouchStart)
    host.removeEventListener('touchmove', onTouchMove)
    host.removeEventListener('touchend', endTouch)
    host.removeEventListener('touchcancel', endTouch)
  }

  term.onData(input)
  const core = (term as any)._core
  if (core?.coreService) core.coreService.isCursorInitialized = true
  fit = new FitAddon()
  term.loadAddon(fit)
  if (wantsWebgl()) {
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => {
        webgl = null
        try {
          gl.dispose()
        } catch {
          /* ignore */
        }
      })
      term.loadAddon(gl)
      webgl = gl
    } catch {
      webgl = null
    }
  }
  term.attachCustomWheelEventHandler((ev) => !ev.ctrlKey)
  harden(term, () => copySelection(term, say))
  subscribe()
  setGeom(localGeom())

  const ctl: KoreTerminal = {
    focus(domFocus = true) {
      focused = true
      term.options.disableStdin = !s.writable
      term.options.cursorBlink = !!s.writable
      // On mobile, domFocus=false: keep the window LOGICALLY focused so the compose box's sends
      // pass the input gate, but skip the xterm DOM focus that would aim the soft keyboard at
      // xterm's hidden textarea instead of the compose box.
      if (domFocus) {
        try {
          term.focus()
        } catch {
          /* ignore */
        }
      }
      fitGeom()
    },
    blur() {
      focused = false
      term.options.disableStdin = true
      term.options.cursorBlink = false
      queue = []
    },
    fit() {
      setGeom(localGeom())
      fitGeom()
    },
    reload() {
      subscribe()
      say('重连中…')
    },
    send(data: string) {
      input(data)
    },
    setCtrl(on: boolean) {
      ctrlArmed = !!on
      onCtrl(ctrlArmed)
    },
    setFont(px: number) {
      if (term.options.fontSize !== px) {
        term.options.fontSize = px
        setGeom(localGeom())
        fitGeom()
      }
    },
    applyRenderer() {
      const want = wantsWebgl()
      if (want && !webgl) {
        try {
          const gl = new WebglAddon()
          gl.onContextLoss(() => {
            webgl = null
            try {
              gl.dispose()
            } catch {
              /* ignore */
            }
          })
          term.loadAddon(gl)
          webgl = gl
        } catch {
          webgl = null
        }
      } else if (!want && webgl) {
        try {
          webgl.dispose()
        } catch {
          /* ignore */
        }
        webgl = null
      }
    },
    dispose() {
      disposed = true
      registry.delete(ctl)
      teardownTouch()
      unsub()
      if (borrowed) release()
      if (webgl) {
        try {
          webgl.dispose()
        } catch {
          /* ignore */
        }
      }
      try {
        term.dispose()
      } catch {
        /* ignore */
      }
      void disposed
    },
  }
  registry.add(ctl)
  return ctl
}
