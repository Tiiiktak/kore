// The multi-window store: mutable state + a version counter emitted to React via
// useSyncExternalStore. Mutating in place (like the old board) keeps window host identity
// stable; React reconciles leaves by key and only repositions them. Persisted to localStorage.
import { useSyncExternalStore } from 'react'
import {
  findSplit,
  leafOf,
  leaves,
  listWins,
  parentOf,
  type Node,
  type Win,
  type WinType,
  type Workspace,
} from './tree'

const KEY = 'kore.wm.v2'

interface State {
  workspaces: Workspace[]
  cur: number
  wins: Record<string, Win>
  view: 'home' | 'stage'
}

let state: State = { workspaces: [], cur: 0, wins: {}, view: 'home' }
let seq = 1
let version = 0
const listeners = new Set<() => void>()

const uid = (p: string) => p + seq++
function emit() {
  version++
  for (const l of listeners) l()
  save()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

// ---- persistence ----
function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        cur: state.cur,
        view: state.view,
        workspaces: state.workspaces.map((w) => ({ id: w.id, name: w.name, focused: w.focused, root: w.root })),
        wins: state.wins,
      }),
    )
  } catch {
    /* ignore */
  }
}
function cleanTree(n: any, wins: Record<string, Win>, seen: Set<string>): Node | null {
  if (!n || typeof n !== 'object') return null
  if (n.t === 'leaf') {
    const m = typeof n.win === 'string' && wins[n.win]
    if (!m || seen.has(n.win)) return null
    seen.add(n.win)
    return { t: 'leaf', win: n.win }
  }
  if (n.t !== 'split' || (n.dir !== 'row' && n.dir !== 'col')) return null
  const a = cleanTree(n.a, wins, seen)
  const b = cleanTree(n.b, wins, seen)
  if (a && b) return { t: 'split', id: n.id || uid('s'), dir: n.dir, r: n.r > 0.05 && n.r < 0.95 ? n.r : 0.5, a, b }
  return a || b
}
function restore(): boolean {
  let d: any
  try {
    d = JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    d = null
  }
  if (!d || !Array.isArray(d.workspaces) || !d.workspaces.length) return false
  const wins: Record<string, Win> = {}
  const out: Workspace[] = []
  for (const w of d.workspaces) {
    const wmap: Record<string, Win> = d.wins && typeof d.wins === 'object' ? d.wins : {}
    const seen = new Set<string>()
    const root = cleanTree(w.root, wmap, seen)
    if (!root) continue
    for (const id of seen) wins[id] = { id, type: wmap[id].type, state: wmap[id].state || {} }
    out.push({ id: w.id || uid('ws'), name: w.name || '工作区', focused: seen.has(w.focused) ? w.focused : null, zoom: null, root })
  }
  if (!out.length) return false
  state.wins = wins
  state.workspaces = out
  state.cur = Math.max(0, Math.min(d.cur | 0, out.length - 1))
  state.view = d.view === 'stage' ? 'stage' : 'home'
  let max = 0
  for (const id of Object.keys(wins)) {
    const n = parseInt(id.replace(/\D/g, ''), 10)
    if (n > max) max = n
  }
  for (const w of out) {
    const n = parseInt(w.id.replace(/\D/g, ''), 10)
    if (n > max) max = n
  }
  seq = max + 1
  return true
}
restore()

// ---- helpers ----
const active = () => state.workspaces[state.cur]
function newWin(type: WinType, winState: Record<string, any> = {}): string {
  const id = uid('w')
  state.wins[id] = { id, type, state: winState }
  return id
}
function leaf(type: WinType, winState?: Record<string, any>): Node {
  return { t: 'leaf', win: newWin(type, winState) }
}
export function termKey(winId: string): string {
  const w = state.wins[winId]
  return w && w.type === 'term' && w.state.node_ip ? w.state.node_ip + '/' + w.state.name : ''
}

// Session keys currently ON SCREEN: every terminal window in the active workspace while the
// stage is showing (home view shows no session). Used to clear the "done" reminder — a session
// you're looking at is, by definition, seen.
export function visibleSessionKeys(): Set<string> {
  const out = new Set<string>()
  if (state.view !== 'stage') return out
  const ws = state.workspaces[state.cur]
  if (!ws) return out
  for (const id of listWins(ws.root)) {
    const k = termKey(id)
    if (k) out.add(k)
  }
  return out
}
function blankWsIndex(): number {
  return state.workspaces.findIndex((w) => {
    if (w.root.t !== 'leaf') return false
    const x = state.wins[w.root.win]
    return x && x.type === 'term' && !x.state.node_ip
  })
}

// Remove one window from a workspace's tree (sibling absorbs its space; a removed root becomes
// a fresh empty window). Deletes the window record and refocuses. Works on ANY workspace,
// so it backs both close() (active) and pruneSessions() (all).
function removeLeaf(ws: Workspace, winId: string) {
  const lf = leafOf(ws.root, winId)
  delete state.wins[winId]
  if (ws.root.t === 'leaf' && ws.root.win === winId) {
    ws.root = leaf('term', {})
    ws.focused = (ws.root as any).win
  } else if (lf) {
    const par = parentOf(ws.root, lf, null) as any
    if (par && par.t === 'split') {
      const sib = par.a === lf ? par.b : par.a
      Object.keys(par).forEach((k) => delete par[k])
      Object.assign(par, sib)
    }
  }
  if (ws.zoom === winId) ws.zoom = null
  const set = new Set<string>()
  leaves(ws.root, set)
  if (!ws.focused || !set.has(ws.focused)) ws.focused = [...set][0] || null
}

// ---- public actions ----
export const wmStore = {
  get: () => state,
  active,
  termKey,
  visibleSessionKeys,

  setView(view: 'home' | 'stage') {
    state.view = view
    emit()
  },

  switchWs(idx: number) {
    if (idx < 0 || idx >= state.workspaces.length) return
    state.cur = idx
    state.view = 'stage'
    emit()
  },

  openWs(id: string) {
    const idx = state.workspaces.findIndex((w) => w.id === id)
    if (idx >= 0) this.switchWs(idx)
  },

  newBlankWorkspace() {
    const blank = blankWsIndex()
    if (blank >= 0) {
      this.switchWs(blank)
      return
    }
    const root = leaf('term', {})
    state.workspaces.push({ id: uid('ws'), name: '工作区', root, focused: (root as any).win, zoom: null })
    this.switchWs(state.workspaces.length - 1)
  },

  // Open a session from the overview: jump to the workspace already showing it, else a new
  // workspace. NEVER replaces an existing window (owner's locked model).
  openSession(session: { node_ip: string; name: string; writable: boolean; label?: string; node?: string }) {
    const key = session.node_ip + '/' + session.name
    for (let i = 0; i < state.workspaces.length; i++) {
      const wid = listWins(state.workspaces[i].root).find((id) => termKey(id) === key)
      if (wid) {
        state.workspaces[i].focused = wid
        this.switchWs(i)
        return
      }
    }
    const blank = blankWsIndex()
    if (blank >= 0) {
      const ws = state.workspaces[blank]
      const winId = (ws.root as any).win
      state.wins[winId] = { id: winId, type: 'term', state: { ...session } }
      ws.focused = winId
      this.switchWs(blank)
      return
    }
    const root = leaf('term', { ...session })
    state.workspaces.push({ id: uid('ws'), name: '工作区', root, focused: (root as any).win, zoom: null })
    this.switchWs(state.workspaces.length - 1)
  },

  closeWs(id: string) {
    const idx = state.workspaces.findIndex((w) => w.id === id)
    if (idx < 0) return
    for (const wid of listWins(state.workspaces[idx].root)) delete state.wins[wid]
    state.workspaces.splice(idx, 1)
    if (!state.workspaces.length) {
      state.cur = 0
      state.view = 'home'
      emit()
      return
    }
    if (idx < state.cur) state.cur -= 1
    state.cur = Math.min(state.cur, state.workspaces.length - 1)
    emit()
  },

  focus(winId: string) {
    const ws = active()
    if (!ws || ws.focused === winId) return
    ws.focused = winId
    emit()
  },

  setWin(winId: string, type: WinType, winState: Record<string, any>) {
    const w = state.wins[winId]
    if (!w) return
    state.wins[winId] = { id: winId, type, state: winState }
    const ws = active()
    if (ws) ws.focused = winId
    emit()
  },

  split(winId: string, dir: 'row' | 'col'): string | null {
    const ws = active()
    const lf = leafOf(ws.root, winId)
    if (!lf || lf.t !== 'leaf') return null
    const empty = leaf('term', {})
    const keep: Node = { t: 'leaf', win: lf.win }
    Object.assign(lf, { t: 'split', id: uid('s'), dir, r: 0.5, a: keep, b: empty } as any)
    delete (lf as any).win
    ws.zoom = null
    ws.focused = (empty as any).win
    emit()
    return (empty as any).win
  },

  close(winId: string) {
    const ws = active()
    if (!ws) return
    // Closing the workspace's ONLY window closes the whole workspace (→ home, or the next
    // workspace) instead of regenerating an empty "new window" page in place.
    if (ws.root.t === 'leaf' && ws.root.win === winId) {
      this.closeWs(ws.id)
      return
    }
    removeLeaf(ws, winId)
    emit()
  },

  // Close any term window whose session is gone (killed / vanished from the roster). Only
  // prunes windows on a node we can currently see (`reachable`) so an unreachable node's
  // windows aren't dropped on a transient scan miss. Keeps workspace tabs in sync with reality.
  pruneSessions(alive: Set<string>, reachable: Set<string>) {
    let changed = false
    for (const ws of state.workspaces) {
      for (const id of listWins(ws.root)) {
        const w = state.wins[id]
        if (!(w && w.type === 'term' && w.state.node_ip)) continue
        const key = w.state.node_ip + '/' + w.state.name
        if (reachable.has(w.state.node_ip) && !alive.has(key)) {
          removeLeaf(ws, id)
          changed = true
        }
      }
    }
    if (changed) emit()
  },

  setRatio(splitId: string, r: number) {
    const ws = active()
    const node = findSplit(ws.root, splitId)
    if (node) {
      node.r = r
      emit()
    }
  },

  // list of workspace terminal windows for tab labels
  wsSummary(ws: Workspace): { dir: 'row' | 'col' | null; names: Array<{ type: WinType; title: string }> } {
    const dir = ws.root.t === 'split' ? ws.root.dir : null
    const names = listWins(ws.root).map((id) => {
      const w = state.wins[id]
      return { type: w?.type ?? 'term', title: w ? winTitle(w) : '?' }
    })
    return { dir, names }
  },
}

export function winTitle(w: Win): string {
  if (w.type === 'term') return w.state.node_ip ? w.state.label || w.state.name : '新窗口'
  if (w.type === 'web') return w.state.title || hostOf(w.state.url) || '浏览器'
  if (w.type === 'files') return w.state.root ? baseName(w.state.root) : '文件'
  return '窗口'
}
export function winSub(w: Win): string {
  if (w.type === 'term') return w.state.node || ''
  if (w.type === 'files') return w.state.nodeName || ''
  return ''
}
function hostOf(u?: string) {
  try {
    return u ? new URL(u).host : ''
  } catch {
    return ''
  }
}
export function baseName(p: string): string {
  const t = String(p || '').replace(/\/+$/, '')
  return t.slice(t.lastIndexOf('/') + 1) || '/'
}

// React binding: re-render on any store change.
export function useWm<T>(selector: (s: State) => T): T {
  useSyncExternalStore(subscribe, () => version)
  return selector(state)
}
export function useWmVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}
