import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { TerminalView } from '@/components/terminal/TerminalView'
import { apiGet, kPost } from '@/lib/api'
import { cn } from '@/lib/utils'

type Pane = { index: number; active: boolean; left: number; top: number; width: number; height: number; command: string; title: string }
type PanesResp = { ok: boolean; win_cols: number; win_rows: number; panes: Pane[] }

// Composite view of ALL panes in a tmux window, laid out by tmux's own geometry — each pane is
// an independent per-pane stream (window + pane targeting). Shown when a window is selected but
// no single pane is pinned. Click a pane to focus it (keystrokes go only to the focused pane;
// pane mode never resizes, so the user's tmux split layout is never disturbed). Falls back to a
// single full-bleed terminal when the window has just one pane.
export function PaneGrid({ winId, nodeIp, name, window: win, writable, focused, mobile, statusBar }: { winId: string; nodeIp: string; name: string; window: number; writable: boolean; focused: boolean; mobile?: boolean; statusBar?: ReactNode }) {
  const [data, setData] = useState<PanesResp | null>(null)
  const [focusIdx, setFocusIdx] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const focusInit = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    focusInit.current = false
    setFocusIdx(null)
    let alive = true
    const load = async () => {
      try {
        const d = await apiGet<PanesResp>(`/api/kore/panes?node_ip=${encodeURIComponent(nodeIp)}&name=${encodeURIComponent(name)}&window=${win}`)
        if (!alive || !d.ok) return
        setData(d)
        if (!focusInit.current && d.panes.length) {
          setFocusIdx((d.panes.find((p) => p.active) || d.panes[0]).index) // default-focus tmux's active pane
          focusInit.current = true
        }
      } catch {
        /* keep the last layout on a transient error */
      }
    }
    load()
    const t = setInterval(load, 2500) // track layout changes (split/resize) while viewing
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [nodeIp, name, win, reload])

  const panes = data?.panes || []
  const cols = data?.win_cols || 0
  const rows = data?.win_rows || 0

  // Drag a divider → resize that pane in tmux (an intentional change to the user's layout).
  // Convert the pixel delta to cells against the live tile size, then resize-pane; refetch.
  const resizePane = async (p: Pane, axis: 'x' | 'y', deltaPx: number) => {
    const el = boxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const body: Record<string, unknown> = { node_ip: nodeIp, name, action: 'resize-pane', window: win, pane: p.index }
    if (axis === 'x') {
      const next = Math.max(1, Math.min(cols - 1, Math.round(p.width + (deltaPx * cols) / r.width)))
      if (next === p.width) return
      body.cols = next
    } else {
      const next = Math.max(1, Math.min(rows - 1, Math.round(p.height + (deltaPx * rows) / r.height)))
      if (next === p.height) return
      body.rows = next
    }
    try {
      await kPost('manage', body)
    } catch {
      /* a refusal surfaces nowhere critical here; the layout just stays put */
    }
    setReload((x) => x + 1)
  }

  if (!data) return <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-xs">读取分屏…</div>
  // Single pane (or geometry unavailable): one full terminal, no grid math.
  if (panes.length <= 1 || !cols || !rows) {
    return <TerminalView nodeIp={nodeIp} name={name} writable={writable} winId={winId} window={win} pane={panes[0]?.index} focused={focused} mobile={mobile} statusBar={statusBar} />
  }
  return (
    <div className="absolute inset-0 flex flex-col">
    <div ref={boxRef} className="bg-background relative min-h-0 flex-1">
      {panes.map((p) => {
        const sel = p.index === focusIdx
        // Abut neighbours (swallow tmux's 1-col/row border gap) so the divider is a single
        // hairline drawn by the handle, not a fat band of background between two framed cells.
        const w = p.width + (p.left + p.width < cols ? 1 : 0)
        const h = p.height + (p.top + p.height < rows ? 1 : 0)
        return (
          <div
            key={p.index}
            onPointerDownCapture={() => setFocusIdx(p.index)}
            className={cn('absolute overflow-hidden', sel ? 'z-[2]' : 'z-[1]')}
            style={{
              left: `${(p.left / cols) * 100}%`,
              top: `${(p.top / rows) * 100}%`,
              width: `${(w / cols) * 100}%`,
              height: `${(h / rows) * 100}%`,
              boxShadow: sel ? 'inset 0 0 0 1px var(--brand)' : undefined, // focus cue only
            }}
          >
            <TerminalView
              nodeIp={nodeIp}
              name={name}
              writable={writable}
              winId={`${winId}:${win}.${p.index}`}
              window={win}
              pane={p.index}
              focused={focused && sel}
              mobile={mobile}
            />
          </div>
        )
      })}
      {/* one hairline per divider; it's a drag handle only when writable (resizing is a write) */}
      {panes.map((p) => (
        <div key={`h${p.index}`}>
          {p.left + p.width < cols && (
            <DragHandle
              orient="x"
              writable={writable}
              style={{ left: `${((p.left + p.width + 0.5) / cols) * 100}%`, top: `${(p.top / rows) * 100}%`, height: `${(p.height / rows) * 100}%` }}
              onResize={(d) => resizePane(p, 'x', d)}
            />
          )}
          {p.top + p.height < rows && (
            <DragHandle
              orient="y"
              writable={writable}
              style={{ top: `${((p.top + p.height + 0.5) / rows) * 100}%`, left: `${(p.left / cols) * 100}%`, width: `${(p.width / cols) * 100}%` }}
              onResize={(d) => resizePane(p, 'y', d)}
            />
          )}
        </div>
      ))}
    </div>
    {statusBar}
    </div>
  )
}

// One hairline per divider. Always a 1px border line; when writable it's also a wider grab zone
// that, on drag, shows a BRAND preview line following the cursor and applies resize-pane on
// release (one write per drag — the far side reflows and we refetch).
function DragHandle({ orient, writable, style, onResize }: { orient: 'x' | 'y'; writable: boolean; style: CSSProperties; onResize: (deltaPx: number) => void }) {
  const start = useRef(0)
  const [drag, setDrag] = useState<number | null>(null) // px offset while dragging (preview)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!writable || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    start.current = orient === 'x' ? e.clientX : e.clientY
    setDrag(0)
    const move = (ev: PointerEvent) => setDrag((orient === 'x' ? ev.clientX : ev.clientY) - start.current)
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      onResize((orient === 'x' ? ev.clientX : ev.clientY) - start.current)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const dragging = drag != null
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        'group absolute z-[4] touch-none',
        orient === 'x' ? 'w-[7px] -translate-x-1/2' : 'h-[7px] -translate-y-1/2',
        writable && (orient === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'),
      )}
      style={style}
    >
      {/* resting hairline */}
      <div
        className={cn(
          'bg-border absolute transition-colors',
          writable && 'group-hover:bg-[var(--brand)]',
          orient === 'x' ? 'inset-y-0 left-1/2 w-px -translate-x-1/2' : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
        )}
      />
      {/* drag preview: a brand line that follows the cursor until release */}
      {dragging && (
        <div
          className={cn('bg-[var(--brand)] pointer-events-none absolute', orient === 'x' ? 'inset-y-0 left-1/2 w-[2px]' : 'inset-x-0 top-1/2 h-[2px]')}
          style={orient === 'x' ? { transform: `translateX(calc(-50% + ${drag}px))` } : { transform: `translateY(calc(-50% + ${drag}px))` }}
        />
      )}
    </div>
  )
}
