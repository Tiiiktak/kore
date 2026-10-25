import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

// The one kore brand mark — the ▐▛▜▌/▝▜▛▘ quadrant glyphs as vector sub-pixels. Reused by the
// top-bar logo and the terminal's connecting loader (and matching the favicon). Each [x, y] is
// a 1×2 cell. `animate` runs the shared `termPixelWave` diagonal light-sweep:
//   'none'  — static;
//   'hover' — one sweep when the mark (or its group) is hovered;
//   'loop'  — sweeps forever (the connecting loader).
const CELLS: ReadonlyArray<readonly [number, number]> = [
  [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0],
  [2, 2], [3, 2], [6, 2], [7, 2],
  [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4],
  [2, 6], [3, 6],
]

export function BrandMark({
  animate = 'none',
  className,
  ...rest
}: ComponentProps<'svg'> & { animate?: 'none' | 'hover' | 'loop' }) {
  return (
    <svg
      viewBox="0 0 8 8"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={cn(animate === 'hover' && 'group/mark', className)}
      {...rest}
    >
      {CELLS.map(([x, y], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width="1"
          height="2"
          className={cn(
            animate === 'hover' && 'group-hover/mark:[animation:termPixelWave_1.4s_ease-in-out]',
            animate === 'loop' && '[animation:termPixelWave_1.5s_ease-in-out_infinite]',
          )}
          style={animate === 'none' ? undefined : { animationDelay: `${((x + y) * 0.05).toFixed(2)}s` }}
        />
      ))}
    </svg>
  )
}
