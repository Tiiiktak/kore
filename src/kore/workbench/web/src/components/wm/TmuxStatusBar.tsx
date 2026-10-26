import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { useRosterCtx } from '@/lib/roster-context'
import { wmStore } from '@/lib/wm/store'
import { cn } from '@/lib/utils'

type TmuxWindow = { index: number; name: string; active: boolean; panes: number }

// A tmux-style status bar along the bottom of a terminal: the session name on the left, the
// window list as clickable tabs (current highlighted, panes count), and a clock on the right —
// the native tmux status line, rebuilt as dashboard UI. Window tabs appear only when the
// session has more than one window; otherwise it's just the session name + clock.
export function TmuxStatusBar({ winId, nodeIp, name, label, window: cur }: { winId: string; nodeIp: string; name: string; label: string; window?: number }) {
  const { roster } = useRosterCtx()
  const sess = roster?.sessions.find((s) => s.node_ip === nodeIp && s.name === name)
  const multi = !!(sess && sess.windows && sess.windows > 1)
  const [wins, setWins] = useState<TmuxWindow[]>([])
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!multi) {
      setWins([])
      return
    }
    let alive = true
    const load = async () => {
      try {
        const d = await apiGet<{ ok: boolean; windows: TmuxWindow[] }>(`/api/kore/windows?node_ip=${encodeURIComponent(nodeIp)}&name=${encodeURIComponent(name)}`)
        if (alive && d.ok) setWins(d.windows || [])
      } catch {
        /* ignore */
      }
    }
    load()
    const t = setInterval(load, 5000) // track renames / new / closed windows
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [nodeIp, name, multi])

  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
  return (
    <div className="bg-secondary text-muted-foreground flex h-5 shrink-0 items-center gap-1 overflow-hidden px-1.5 text-[11px] [scrollbar-width:none]">
      <span className="shrink-0 font-medium" style={{ color: 'var(--brand)' }}>
        {label}
      </span>
      {multi && (
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {wins.map((w) => {
            const sel = cur == null ? w.active : w.index === cur
            return (
              <button
                key={w.index}
                onClick={() => wmStore.setWindow(winId, w.index, undefined)}
                title={`窗口 ${w.index}: ${w.name}${w.panes > 1 ? ` · ${w.panes} 分屏` : ''}`}
                className={cn(
                  'shrink-0 rounded px-1 tabular-nums transition-colors',
                  sel ? 'bg-[var(--brand)] text-[var(--primary-foreground)]' : 'hover:bg-foreground/10 hover:text-foreground',
                )}
              >
                {w.index}
                {w.name ? `:${w.name}` : ''}
                {w.panes > 1 ? `·${w.panes}` : ''}
              </button>
            )
          })}
        </div>
      )}
      {!multi && <span className="min-w-0 flex-1" />}
      <span className="shrink-0 tabular-nums">{hhmm}</span>
    </div>
  )
}
