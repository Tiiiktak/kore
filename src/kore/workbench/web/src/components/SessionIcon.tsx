import { LOGO } from '@/lib/kore'
import { cn } from '@/lib/utils'

// Colored rounded tile + white pixel "kore" logo. `size` is the tile edge in px.
export function SessionIcon({ bg, size = 28, className }: { bg: string; size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-[7px] select-none', className)}
      style={{ width: size, height: size, background: bg }}
    >
      <svg viewBox={LOGO.viewBox} fill="#fff" shapeRendering="crispEdges" aria-hidden className="block" style={{ width: '80%', height: 'auto' }}>
        {LOGO.rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />
        ))}
      </svg>
    </span>
  )
}
