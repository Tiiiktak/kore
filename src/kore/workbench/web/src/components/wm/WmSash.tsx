import { useRef } from 'react'
import { wmStore } from '@/lib/wm/store'
import { WM_GAP, WM_MIN_H, WM_MIN_W, regionOfSplit, type Sash } from '@/lib/wm/tree'
import { cn } from '@/lib/utils'

// Draggable divider. Pointer capture routes move events to the sash itself, so dragging over
// an iframe/xterm never breaks. Invisible at rest; the accent bar fades in on hover/drag.
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
      <div
        className={cn(
          'absolute rounded-full bg-[var(--brand)] opacity-0 transition-opacity delay-200 group-hover:opacity-100 group-data-[on]:opacity-100 group-data-[on]:delay-0',
          horiz ? 'inset-y-[18%] left-1/2 w-[3px] -translate-x-1/2' : 'inset-x-[18%] top-1/2 h-[3px] -translate-y-1/2',
        )}
      />
    </div>
  )
}
