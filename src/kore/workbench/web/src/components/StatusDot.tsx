import { cn } from '@/lib/utils'

// One status convention, reused on cards, workspace tabs, KPI tiles and the overview alert. Every
// surface reads the same --st-* tokens (index.css), so a state never changes colour by location:
//   green  = working (busy)      — calm breathing ring
//   blue   = just finished (done)— calm breathing ring; a one-shot "去看看" that clears once seen
//   grey   = idle                — steady
//   yellow = needs you (waiting) — urgent flash (急闪)
//   red    = Claude exited (dead)
//   hollow = tmux only, Claude not running
const MAP: Record<string, { color: string; pulse?: boolean; blink?: boolean; hollow?: boolean }> = {
  busy: { color: 'var(--st-busy)', pulse: true },
  done: { color: 'var(--st-done)', pulse: true },
  waiting: { color: 'var(--st-waiting)', blink: true },
  idle: { color: 'var(--st-idle)' },
  dead: { color: 'var(--st-dead)' },
  tmux_only: { color: 'var(--st-tmux)', hollow: true },
}

// The text-tag counterpart of the dot (card state label): same token, tinted background.
export const STATE_TAG: Record<string, string> = {
  busy: 'text-st-busy bg-st-busy-bg',
  waiting: 'text-st-waiting bg-st-waiting-bg font-semibold',
  done: 'text-st-done bg-st-done-bg font-medium',
  dead: 'text-st-dead bg-st-dead-bg',
}

export function StatusDot({ state, className }: { state: string; className?: string }) {
  const m = MAP[state] || MAP.idle
  return (
    <span
      className={cn(
        'relative inline-block size-2 shrink-0 rounded-full transition-[background-color,box-shadow,color] duration-300',
        m.pulse && 'kore-pulse',
        m.blink && 'kore-blink',
        className,
      )}
      style={{
        background: m.hollow ? 'transparent' : m.color,
        boxShadow: m.hollow
          ? `inset 0 0 0 1.5px ${m.color}`
          : m.pulse
            ? `0 0 0 2px color-mix(in srgb, ${m.color} 22%, transparent)`
            : undefined,
        color: m.color,
      }}
      aria-hidden
    />
  )
}
