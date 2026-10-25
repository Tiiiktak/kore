import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Thin wrapper to give an icon button (or any element) an instant, styled hover tooltip.
// Wrap a single element: <Hint label="刷新"><button>…</button></Hint>. Keep the child's own
// aria-label for screen readers — the tooltip is the visual hint. Renders the child untouched
// when there's no label, so it's safe to pass a conditional string.
export function Hint({
  label,
  side = 'top',
  align = 'center',
  children,
}: {
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  children: ReactElement
}) {
  if (!label) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
