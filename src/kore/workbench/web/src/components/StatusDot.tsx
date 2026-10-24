import { cn } from '@/lib/utils'

// One status convention, reused on cards, workspace tabs, and the overview alert:
//   green  = working (busy)      — calm breathing ring
//   blue   = just finished (done)— calm breathing ring; a one-shot "去看看" that clears once seen
//   grey   = idle                — steady
//   yellow = needs you (waiting) — urgent flash (急闪)
//   red    = Claude exited (dead)
const MAP: Record<string, { color: string; ring?: string; pulse?: boolean; blink?: boolean; hollow?: boolean }> = {
  busy: { color: 'var(--ok)', ring: 'var(--ok-bg)', pulse: true },
  done: { color: 'var(--done)', ring: 'var(--done)', pulse: true },
  waiting: { color: 'var(--busy)', blink: true },
  idle: { color: 'var(--muted-foreground)' },
  dead: { color: 'var(--bad)' },
  tmux_only: { color: 'var(--edge)', hollow: true },
}

export function StatusDot({ state, className }: { state: string; className?: string }) {
  const m = MAP[state] || MAP.idle
  return (
    <span
      className={cn(
        'relative inline-block size-2 shrink-0 rounded-full',
        m.pulse && 'kore-pulse',
        m.blink && 'kore-blink',
        className,
      )}
      style={{
        background: m.hollow ? 'transparent' : m.color,
        boxShadow: m.hollow
          ? `inset 0 0 0 1.5px ${m.color}`
          : m.ring
            ? `0 0 0 2px color-mix(in srgb, ${m.color} 22%, transparent)`
            : undefined,
        color: m.color,
      }}
      aria-hidden
    />
  )
}
