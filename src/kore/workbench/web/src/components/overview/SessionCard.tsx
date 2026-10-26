import { useRef, useState } from 'react'
import { Star, TerminalSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { kPost } from '@/lib/api'
import { StatusDot } from '@/components/StatusDot'
import { Hint } from '@/components/Hint'
import { sessKey, sessName, stateLabel } from '@/lib/kore'
import type { Labels, Session } from '@/lib/types'
import { cn } from '@/lib/utils'

const STATE_TAG: Record<string, string> = {
  busy: 'text-busy bg-busy-bg',
  waiting: 'text-claude bg-busy-bg font-semibold',
  done: 'text-[var(--done)] bg-[var(--idle-bg)] font-medium',
}

// A compact session card for the overview grid. Whole card opens the session; star toggles.
export function SessionCard({
  s,
  displayState,
  labels,
  prefix,
  starred,
  onToggleStar,
  onOpen,
  onChanged,
  onRename,
}: {
  s: Session
  displayState?: string
  labels: Labels
  prefix: string
  starred: boolean
  onToggleStar: (id: string) => void
  onOpen: (s: Session) => void
  onChanged: () => void
  onRename: () => void
}) {
  const st = displayState || s.state
  const [armed, setArmed] = useState(false)
  const armT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const kill = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!armed) {
      setArmed(true)
      if (armT.current) clearTimeout(armT.current)
      armT.current = setTimeout(() => setArmed(false), 3000)
      return
    }
    if (armT.current) clearTimeout(armT.current)
    setArmed(false)
    try {
      await kPost('stop', { node_ip: s.node_ip, name: s.name })
      toast('已结束会话', { description: name })
      setTimeout(onChanged, 1200)
    } catch (err) {
      toast.error('结束失败', { description: (err as Error).message })
    }
  }
  const id = sessKey(s)
  const name = sessName(s, labels, prefix)
  // always surface the original tmux name (prefix kept) when it differs from what we show
  const real = s.name !== name ? s.name : ''
  const lock = s.protected ? '受保护' : !s.writable ? '不可写' : ''
  const summary = (s.summary || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .join('\n')
  const meta = [s.job_name, s.gpus ? `${s.gpus} GPU` : '', s.role].filter(Boolean).join(' · ')
  // live tmux facts: a window/pane count badge (only when there's more than one — a hint that
  // this session has tabs/splits worth opening) and the active pane's current directory.
  const wp = [s.windows && s.windows > 1 ? `${s.windows} 窗口` : '', s.panes && s.panes > 1 ? `${s.panes} 分屏` : '']
    .filter(Boolean)
    .join(' · ')
  const cwd = s.live_cwd || s.cwd || ''

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(s)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(s)}
      className="group bg-card hover:border-ring hover:bg-accent/40 relative flex h-[128px] cursor-pointer flex-col rounded-lg border p-3 text-left transition-colors"
    >
      <div className="flex items-center gap-2">
        <StatusDot state={st} />
        <Hint label="改备注名">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRename()
            }}
            aria-label="改备注名"
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
          >
            <TerminalSquare className="size-[18px]" />
          </button>
        </Hint>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight">
          {name}
          {real && <span className="text-muted-foreground ml-1 text-[11px] font-normal">{real}</span>}
        </span>
        <button
          aria-label={starred ? '取消星标' : '星标（置顶）'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleStar(id)
          }}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded transition-opacity',
            starred
              ? 'text-[var(--busy)] opacity-100'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <Star className="size-4" fill={starred ? 'currentColor' : 'none'} />
        </button>
        <Hint label={armed ? '再点一次 = 真结束（kill 整个 tmux，不可撤）' : '结束 session'}>
          <button
            aria-label={armed ? '确认结束' : '结束 session'}
            onClick={kill}
            className={cn(
              'flex shrink-0 items-center justify-center rounded transition-opacity',
              armed
                ? 'bg-[var(--bad)] h-6 px-1.5 text-[10px] font-semibold text-white opacity-100'
                : 'text-muted-foreground hover:bg-[var(--bad-bg)] hover:text-[var(--bad)] size-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            {armed ? '确认' : <Trash2 className="size-4" />}
          </button>
        </Hint>
        <span
          className={cn(
            'text-muted-foreground bg-muted shrink-0 rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap',
            STATE_TAG[st],
          )}
        >
          {stateLabel(st)}
        </span>
      </div>

      {summary ? (
        <div className="text-muted-foreground mt-2 line-clamp-3 flex-1 text-[12px] leading-relaxed break-words whitespace-pre-wrap">
          {summary}
        </div>
      ) : (
        <div className="text-muted-foreground/60 mt-2 flex-1 text-[12px]">—</div>
      )}

      {(meta || lock || wp || cwd) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {lock && <span className="text-brand bg-brand-bg shrink-0 rounded px-1.5 py-0.5 text-[10px]">{lock}</span>}
          {wp && <span className="text-muted-foreground bg-muted shrink-0 rounded px-1.5 py-0.5 text-[10px]">{wp}</span>}
          {meta && <span className="text-muted-foreground min-w-0 shrink truncate text-[11px]">{meta}</span>}
          {cwd && (
            <span className="text-muted-foreground/70 ml-auto min-w-0 max-w-[55%] shrink-0 truncate pl-1 font-mono text-[10px] [direction:rtl]">
              {cwd}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
