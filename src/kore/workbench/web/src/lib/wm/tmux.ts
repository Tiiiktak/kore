// Shared helpers for driving tmux from the dashboard (approach A: dashboard action -> tmux
// command). Used by the bottom status bar, the leader-key menu, and the command palette.
import { kPost } from '@/lib/api'
import { wmStore } from './store'

export interface FocusedTerm {
  winId: string
  node_ip: string
  name: string
  window?: number
  pane?: number
  writable: boolean
}

// The terminal window currently focused in the active workspace, or null if the focus isn't a
// live terminal. tmux actions target this.
export function focusedTerm(): FocusedTerm | null {
  const ws = wmStore.active()
  if (!ws || !ws.focused) return null
  const w = wmStore.get().wins[ws.focused]
  if (!w || w.type !== 'term' || !w.state.node_ip) return null
  return { winId: ws.focused, node_ip: w.state.node_ip, name: w.state.name, window: w.state.window, pane: w.state.pane, writable: !!w.state.writable }
}

// Run a tmux management action on the focused terminal's session. Returns false if there's no
// focused terminal or the action was refused (caller may toast).
export async function tmuxManage(body: Record<string, unknown>): Promise<boolean> {
  const t = focusedTerm()
  if (!t) return false
  try {
    await kPost('manage', { node_ip: t.node_ip, name: t.name, ...body })
    return true
  } catch {
    return false
  }
}
