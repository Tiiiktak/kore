import { useRef } from 'react'
import { wmStore } from '@/lib/wm/store'
import { WM_GAP, WM_MIN_H, WM_MIN_W, regionOfSplit, type Sash } from '@/lib/wm/tree'
import { cn } from '@/lib/utils'

// Draggable divider. Pointer capture routes move events to the sash itself, so dragging over
// an iframe/xterm never breaks. A permanent 1px hairline divides the workspace card; it brightens
// to the accent color on hover/drag. The actual grab zone is wider than the line so it's easy to hit.
export function WmSash({ sash, box }: { sash: Sash; box: { w: number; h: number } }) {
  const ref = useRef<HTMLDivElement>(null)
  const horiz = sash.dir === 'row'

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = ref.current!
    el.setPointerCapture(e.pointerId)
    el.dataset.on = '1'
    let raf = 0
    let lastX = 0
    let lastY = 0
    const apply = () => {
      raf = 0
      const reg = regionOfSplit(wmStore.active().root, box, sash.id)
      if (!reg) return
      const span = horiz ? reg.w : reg.h
      const start = horiz ? reg.x : reg.y
      const pos = horiz ? lastX : lastY
      const minPx = Math.min(horiz ? WM_MIN_W : WM_MIN_H, Math.max(60, (span - WM_GAP) / 2))
      let r = (pos - start) / span
      r = Math.max(minPx / span, Math.min(1 - minPx / span, r))
      if (Number.isFinite(r)) wmStore.setRatio(sash.id, r)
    }
    const stageRect = el.parentElement!.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX - stageRect.left
      lastY = ev.clientY - stageRect.top
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const up = () => {
      if (raf) cancelAnimationFrame(raf)
      delete el.dataset.on
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('lostpointercapture', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('lostpointercapture', up)
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      className={cn(
        'group absolute z-[7] touch-none',
        horiz ? 'cursor-col-resize' : 'cursor-row-resize',
      )}
      style={{ left: sash.x, top: sash.y, width: sash.w, height: sash.h }}
      role="separator"
      aria-orientation={horiz ? 'vertical' : 'horizontal'}
    >
      {/* wider invisible grab zone, centered on the 1px line */}
      <div className={cn('absolute', horiz ? '-inset-x-[5px] inset-y-0' : '-inset-y-[5px] inset-x-0')} />
      {/* the hairline itself: fills the 1px gap, brightens to brand on hover/drag */}
      <div className="bg-border group-hover:bg-[var(--brand)] group-data-[on]:bg-[var(--brand)] absolute inset-0 transition-colors delay-150 group-data-[on]:delay-0" />
    </div>
  )
}
