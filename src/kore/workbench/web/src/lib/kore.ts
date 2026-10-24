// Naming / grouping / icon helpers ported verbatim-in-spirit from the old board so the
// overview shows identical labels, colors, and ordering.
import type { Labels, NodeInfo, Session } from './types'

export const STATE_LABEL: Record<string, string> = {
  busy: '运行中',
  waiting: '需要你',
  done: '刚完成',
  idle: '空闲',
  tmux_only: 'Claude 未运行',
  dead: '已断开',
}
export const stateLabel = (st: string) => STATE_LABEL[st] || st || ''

export const stripPrefix = (name: string, prefix: string) =>
  prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name

export const sessKey = (s: Pick<Session, 'node_ip' | 'name'>) => s.node_ip + '/' + s.name

// FNV-1a 32-bit — stable color-from-string (identical to the old board's kHash).
function hash(str: string): number {
  let h = 0x811c9dc5
  for (const c of String(str)) {
    h ^= c.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const ICON_BGS = [
  '#e5534b', '#f0883e', '#c69026', '#2da44e', '#1f9ead', '#3b82f6',
  '#6366f1', '#8b5cf6', '#c026d3', '#ec4899', '#64748b',
]
export const sessIconBg = (name: string, prefix: string) =>
  ICON_BGS[hash(stripPrefix(name, prefix)) % ICON_BGS.length]

const NODE_SELF = '#d77757'
const NODE_COLORS = ['#0969da', '#8250df', '#1a7f37', '#bf3989', '#0e7c86', '#9a6700', '#cf222e']
export function nodeColor(ip: string, self: boolean): string {
  if (self) return NODE_SELF
  let h = 0
  for (const c of String(ip)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return NODE_COLORS[h % NODE_COLORS.length]
}

export interface NodeView {
  ip: string
  self: boolean
  hostname: string
  color: string
}

export function buildNodes(nodes: NodeInfo[]): Record<string, NodeView> {
  const out: Record<string, NodeView> = {}
  for (const n of nodes)
    out[n.node_ip] = {
      ip: n.node_ip,
      self: !!n.self,
      hostname: n.hostname || '',
      color: nodeColor(n.node_ip, !!n.self),
    }
  return out
}

export const emptyLabels: Labels = { nodes: {}, sessions: {} }

export function sessName(s: Session, labels: Labels, prefix: string): string {
  return labels.sessions[sessKey(s)]?.name || stripPrefix(s.name, prefix)
}

export function nodeName(ip: string, nodes: Record<string, NodeView>, labels: Labels): string {
  const n = nodes[ip]
  const host = (n?.hostname || '').split('.')[0]
  return labels.nodes[ip]?.name || (n?.self ? '本机' : host || ip)
}

export function nodeOrder(ip: string, nodes: Record<string, NodeView>): string {
  const n = nodes[ip]
  return (n?.self ? '0' : '1') + (n?.hostname || ip)
}

// The pixel "kore" logo: quadrant-block glyphs decomposed into sub-pixels → SVG rects,
// exactly as the old board built KORE_LOGO_SVG (so the icon is byte-for-byte the same mark).
const LOGO_ROWS = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']
export interface LogoGeom {
  viewBox: string
  rects: Array<{ x: number; y: number; w: number; h: number }>
}
export const LOGO: LogoGeom = (() => {
  const Q: Record<string, number> = {
    '▘': 8, '▝': 4, '▀': 12, '▖': 2, '▌': 10, '▞': 6, '▛': 14, '▗': 1,
    '▚': 9, '▐': 5, '▜': 13, '▄': 3, '▙': 11, '▟': 7, '█': 15,
  }
  const px: Array<[number, number]> = []
  LOGO_ROWS.forEach((row, ry) =>
    [...row].forEach((ch, cx) => {
      const b = Q[ch] || 0
      ;([[8, 0, 0], [4, 1, 0], [2, 0, 1], [1, 1, 1]] as const).forEach(([bit, dx, dy]) => {
        if (b & bit) px.push([cx * 2 + dx, ry * 2 + dy])
      })
    }),
  )
  const xs = px.map((p) => p[0])
  const ys = px.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const w = Math.max(...xs) - x0 + 1
  const h = Math.max(...ys) - y0 + 1
  const PH = 1.4
  const rects = px.map(([x, y]) => ({
    x: x - x0,
    y: +((y - y0) * PH).toFixed(2),
    w: 1.02,
    h: +(PH + 0.02).toFixed(2),
  }))
  return { viewBox: `0 0 ${w} ${+(h * PH).toFixed(2)}`, rects }
})()
