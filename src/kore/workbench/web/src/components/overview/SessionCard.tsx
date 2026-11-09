import { useState } from 'react'
import { Ellipsis, Pencil, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { kPost } from '@/lib/api'
import { STATE_TAG, StatusDot } from '@/components/StatusDot'
import { ConfirmPopover } from '@/components/ConfirmPopover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { sessKey, sessName, stateLabel } from '@/lib/kore'
import type { Labels, Session } from '@/lib/types'
import { cn } from '@/lib/utils'

// Hover-revealed card controls: shown on hover / keyboard focus, and always on touch screens
// (no hover there), and kept visible while their own menu is open.
const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100 data-[state=open]:opacity-100'

// A compact session card for the overview grid. Whole card opens the session; double-click the
// name to rename; star pins; the ⋯ menu holds rename / star / 结束 session (popover confirm).
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
  const [confirmKill, setConfirmKill] = useState(false)
  const id = sessKey(s)
  const name = sessName(s, labels, prefix)
  const kill = async () => {
    await kPost('stop', { node_ip: s.node_ip, name: s.name })
    toast('已结束 session', { description: name })
    setTimeout(onChanged, 1200)
  }
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
      onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && onOpen(s)}
      className="group bg-card hover:border-ring hover:bg-accent/40 relative flex h-[128px] cursor-pointer flex-col rounded-lg border p-3 text-left transition-colors"
    >
      <div className="flex items-center gap-2">
        <StatusDot state={st} />
        <span
          onDoubleClick={(e) => {
            e.stopPropagation()
            onRename()
          }}
          title="双击改备注名"
          className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight"
        >
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
            starred ? 'text-warn opacity-100' : cn('text-muted-foreground hover:bg-muted hover:text-foreground', REVEAL),
          )}
        >
          <Star className="size-4" fill={starred ? 'currentColor' : 'none'} />
        </button>
        <ConfirmPopover
          anchorOnly
          open={confirmKill}
          onOpenChange={setConfirmKill}
          title={`结束 ${name}？`}
          desc="kill 整个 tmux session（含其中所有窗口和进程），不可撤销。"
          confirmLabel="结束 session"
          run={kill}
        >
          <span className="inline-flex shrink-0">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="更多操作"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted flex size-6 items-center justify-center rounded transition-opacity',
                    confirmKill ? 'opacity-100' : REVEAL,
                  )}
                >
                  <Ellipsis className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-36 whitespace-nowrap"
                onClick={(e) => e.stopPropagation()}
                // keep focus off the trigger so the kill confirm (anchored there) isn't dismissed
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <DropdownMenuItem onSelect={onRename}>
                  <Pencil /> 改备注名
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onToggleStar(id)}>
                  <Star /> {starred ? '取消星标' : '星标（置顶）'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => requestAnimationFrame(() => setConfirmKill(true))}>
                  <Trash2 /> 结束 session…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </ConfirmPopover>
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
