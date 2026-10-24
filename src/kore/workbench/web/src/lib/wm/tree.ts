// Split-tree model for the multi-window stage. A workspace's layout is a binary tree:
// leaf -> one window; split -> two children divided horizontally (row) or vertically (col)
// by ratio r. Rects are computed from the tree + the measured stage box; windows are NEVER
// reparented (keyed by id in React), only repositioned — so xterm/iframe hosts survive.

export type WinType = 'term' | 'web' | 'files'

export interface Win {
  id: string
  type: WinType
  state: Record<string, any>
}

export type Node =
  | { t: 'leaf'; win: string }
  | { t: 'split'; id: string; dir: 'row' | 'col'; r: number; a: Node; b: Node }

export interface Workspace {
  id: string
  name: string
  root: Node
  focused: string | null
  zoom: string | null
}

export const WM_GAP = 6
export const WM_MIN_W = 240
export const WM_MIN_H = 140

export interface Rect {
  win: string
  x: number
  y: number
  w: number
  h: number
}
export interface Sash {
  id: string
  dir: 'row' | 'col'
  x: number
  y: number
  w: number
  h: number
}

export function computeRects(node: Node, x: number, y: number, w: number, h: number, rects: Rect[], sashes: Sash[]) {
  if (node.t === 'leaf') {
    rects.push({ win: node.win, x, y, w, h })
    return
  }
  const horiz = node.dir === 'row'
  const total = horiz ? w : h
  const a = Math.round((total - WM_GAP) * node.r)
  const b = total - WM_GAP - a
  if (horiz) {
    computeRects(node.a, x, y, a, h, rects, sashes)
    computeRects(node.b, x + a + WM_GAP, y, b, h, rects, sashes)
    sashes.push({ id: node.id, dir: 'row', x: x + a, y, w: WM_GAP, h })
  } else {
    computeRects(node.a, x, y, w, a, rects, sashes)
    computeRects(node.b, x, y + a + WM_GAP, w, b, rects, sashes)
    sashes.push({ id: node.id, dir: 'col', x, y: y + a, w, h: WM_GAP })
  }
}

export function leaves(n: Node, set: Set<string>) {
  if (n.t === 'leaf') set.add(n.win)
  else {
    leaves(n.a, set)
    leaves(n.b, set)
  }
}
export function listWins(n: Node, acc: string[] = []): string[] {
  if (n.t === 'leaf') acc.push(n.win)
  else {
    listWins(n.a, acc)
    listWins(n.b, acc)
  }
  return acc
}
export function findSplit(root: Node, id: string): Extract<Node, { t: 'split' }> | null {
  if (root.t !== 'split') return null
  if (root.id === id) return root
  return findSplit(root.a, id) || findSplit(root.b, id)
}
export function parentOf(root: Node, child: Node, par: Node | null = null): Node | null {
  if (root === child) return par
  if (root.t === 'split') return parentOf(root.a, child, root) || parentOf(root.b, child, root)
  return null
}
// Pixel region occupied by a given split node's subtree (for sash drag math).
export function regionOfSplit(
  root: Node,
  box: { w: number; h: number },
  splitId: string,
): { x: number; y: number; w: number; h: number } | null {
  let found: { x: number; y: number; w: number; h: number } | null = null
  const walk = (n: Node, x: number, y: number, w: number, h: number) => {
    if (n.t === 'split') {
      if (n.id === splitId) found = { x, y, w, h }
      const horiz = n.dir === 'row'
      const total = horiz ? w : h
      const a = Math.round((total - WM_GAP) * n.r)
      const b = total - WM_GAP - a
      if (horiz) {
        walk(n.a, x, y, a, h)
        walk(n.b, x + a + WM_GAP, y, b, h)
      } else {
        walk(n.a, x, y, w, a)
        walk(n.b, x, y + a + WM_GAP, w, b)
      }
    }
  }
  walk(root, 0, 0, box.w, box.h)
  return found
}

export function leafOf(root: Node, winId: string): Node | null {
  let found: Node | null = null
  const walk = (n: Node) => {
    if (n.t === 'leaf') {
      if (n.win === winId) found = n
    } else {
      walk(n.a)
      walk(n.b)
    }
  }
  walk(root)
  return found
}
