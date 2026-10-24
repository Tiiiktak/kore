import { useEffect, useRef, useState } from 'react'
import { WmWindow } from './WmWindow'
import { WmSash } from './WmSash'
import { useWmVersion, winTitle, wmStore } from '@/lib/wm/store'
import { computeRects, listWins, type Rect, type Sash } from '@/lib/wm/tree'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'
import { cn } from '@/lib/utils'

const SWITCHER_H = 36

// The multi-window stage. Desktop: lays out the active workspace's split tree (windows keyed
// by id so their hosts survive re-layout). Mobile: shows only the focused window full-bleed,
// with a bottom switcher to move between the workspace's windows (no split tiles / sashes).
export function WmStage() {
  useWmVersion()
  const mobile = useIsMobile()
  const kbInset = useKeyboardInset()
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ws = wmStore.active()
  const ready = ws && box.w > 0 && box.h > 0

  if (mobile) {
    const ids = ws ? listWins(ws.root) : []
    const fid = ws && ws.focused && ids.includes(ws.focused) ? ws.focused : ids[0]
    const multi = ids.length > 1
    return (
      <div className="bg-background absolute inset-0 flex flex-col" style={{ bottom: kbInset }}>
        <div ref={ref} className="relative min-h-0 flex-1">
          {ready && fid && (
            <WmWindow key={fid} rect={{ win: fid, x: 0, y: 0, w: box.w, h: box.h }} active mobile />
          )}
        </div>
        {multi && (
          <div className="bg-background flex shrink-0 items-center gap-1 overflow-x-auto border-t px-2 py-1 [scrollbar-width:none]" style={{ height: SWITCHER_H }}>
            {ids.map((id) => {
              const w = wmStore.get().wins[id]
              return (
                <button
                  key={id}
                  onClick={() => wmStore.focus(id)}
                  className={cn(
                    'flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs',
                    id === fid ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground',
                  )}
                >
                  {w ? winTitle(w) : '窗口'}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const rects: Rect[] = []
  const sashes: Sash[] = []
  if (ready) computeRects(ws.root, 0, 0, box.w, box.h, rects, sashes)

  return (
    <div className="bg-background absolute inset-0 p-2">
      <div ref={ref} className="relative size-full">
        {rects.map((r) => (
          <WmWindow key={r.win} rect={r} active={ws?.focused === r.win} />
        ))}
        {sashes.map((s) => (
          <WmSash key={s.id} sash={s} box={box} />
        ))}
      </div>
    </div>
  )
}
