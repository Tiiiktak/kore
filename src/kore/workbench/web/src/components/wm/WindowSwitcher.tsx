import { type ReactNode, useState } from 'react'
import { ChevronRight, Columns2, Pencil, Plus, SquareStack, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { apiGet, kPost } from '@/lib/api'
import { useRosterCtx } from '@/lib/roster-context'
import { wmStore } from '@/lib/wm/store'
import { cn } from '@/lib/utils'

type TmuxWindow = { index: number; name: string; active: boolean; panes: number }
type TmuxPane = { index: number; active: boolean; command: string; title: string }

// Header control: switch the terminal between the session's tmux windows (and a window's panes),
// AND manage them (approach A — dashboard actions map to tmux commands: new / rename / kill /
// split). Only shown when the session has >1 window. Lists are fetched lazily.
export function WindowSwitcher({
  winId,
  nodeIp,
  name,
  current,
  currentPane,
}: {
  winId: string
  nodeIp: string
  name: string
  current?: number
  currentPane?: number
}) {
  const { roster } = useRosterCtx()
  const sess = roster?.sessions.find((s) => s.node_ip === nodeIp && s.name === name)
  const [open, setOpen] = useState(false)
  const [wins, setWins] = useState<TmuxWindow[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [panes, setPanes] = useState<TmuxPane[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [busy, setBusy] = useState(false)

  if (!sess || !(sess.windows && sess.windows > 1)) return null

  const loadWindows = async () => {
    try {
      const d = await apiGet<{ ok: boolean; windows: TmuxWindow[] }>(`/api/kore/windows?node_ip=${encodeURIComponent(nodeIp)}&name=${encodeURIComponent(name)}`)
      if (d.ok) setWins(d.windows || [])
    } catch {
      /* ignore */
    }
  }
  const loadPanes = async (w: number) => {
    setExpanded(w)
    setPanes([])
    try {
      const d = await apiGet<{ ok: boolean; panes: TmuxPane[] }>(`/api/kore/panes?node_ip=${encodeURIComponent(nodeIp)}&name=${encodeURIComponent(name)}&window=${w}`)
      if (d.ok) setPanes(d.panes || [])
    } catch {
      /* ignore */
    }
  }
  // Run a tmux-management action, then refresh the lists so the popover reflects the new state.
  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setBusy(true)
    try {
      await kPost('manage', { node_ip: nodeIp, name, ...body })
      await loadWindows()
      if (expanded != null) await loadPanes(expanded)
      after?.()
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const pickWindow = (w: number | undefined) => {
    wmStore.setWindow(winId, w, undefined)
    setOpen(false)
  }
  const pickPane = (w: number, p: number) => {
    wmStore.setWindow(winId, w, p)
    setOpen(false)
  }

  const pinned = current != null
  const curWin = current != null ? wins.find((w) => w.index === current) : undefined
  const label =
    current == null
      ? '活动窗口'
      : currentPane != null
        ? `窗口 ${current} · 分屏 ${currentPane}`
        : `窗口 ${current}${curWin && curWin.panes > 1 ? ' · 全部分屏' : ''}`
  const stateLine =
    current == null
      ? `当前:跟随活动窗口(共 ${sess.windows} 个)`
      : currentPane != null
        ? `当前:窗口 ${current} 的分屏 ${currentPane}`
        : `当前:窗口 ${current}${curWin && curWin.panes > 1 ? `(复合显示 ${curWin.panes} 个分屏)` : ''}`

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        setEditing(null)
        if (o) {
          setExpanded(null)
          loadWindows()
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            'hover:bg-foreground/10 aria-expanded:bg-foreground/10 flex h-6 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12px] transition-colors',
            pinned ? 'text-[var(--brand)] bg-[var(--brand-bg)]' : 'text-muted-foreground hover:text-foreground',
          )}
          title="切换 / 管理 tmux 窗口 · 分屏"
        >
          <SquareStack className="size-3.5" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[60vh] w-[260px] overflow-auto p-1">
        <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
          <span className="text-muted-foreground text-[11px]">{stateLine}</span>
          <button
            onClick={() => run({ action: 'new-window' })}
            disabled={busy}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 items-center justify-center rounded disabled:opacity-50"
            title="新建窗口"
            aria-label="新建窗口"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <button
          onClick={() => pickWindow(undefined)}
          className={cn('hover:bg-accent flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm', current == null && 'bg-accent')}
        >
          跟随活动窗口
        </button>
        {wins.map((w) => (
          <div key={w.index}>
            <div className={cn('group flex items-center rounded-md', current === w.index && currentPane == null && 'bg-accent')}>
              {editing === w.index ? (
                <input
                  value={editName}
                  autoFocus
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editName.trim()) run({ action: 'rename-window', window: w.index, title: editName.trim() }, () => setEditing(null))
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={() => setEditing(null)}
                  className="bg-card mx-1 my-0.5 h-7 min-w-0 flex-1 rounded-md px-2 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
                />
              ) : (
                <>
                  <button onClick={() => pickWindow(w.index)} className="hover:bg-accent flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm">
                    <span className="text-muted-foreground tabular-nums">{w.index}</span>
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {w.active && (
                      <span className="text-[11px]" style={{ color: 'var(--brand)' }}>
                        活动
                      </span>
                    )}
                  </button>
                  {/* management actions — appear on row hover */}
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                    <IconBtn title="重命名" onClick={() => { setEditing(w.index); setEditName(w.name) }}>
                      <Pencil className="size-3.5" />
                    </IconBtn>
                    <IconBtn title="在此窗口分屏" onClick={() => run({ action: 'split-window', window: w.index, dir: 'h' })}>
                      <Columns2 className="size-3.5" />
                    </IconBtn>
                    <IconBtn title="关闭窗口" bad onClick={() => run({ action: 'kill-window', window: w.index })}>
                      <X className="size-3.5" />
                    </IconBtn>
                  </div>
                  {w.panes > 1 && (
                    <button
                      onClick={() => (expanded === w.index ? setExpanded(null) : loadPanes(w.index))}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground mr-0.5 flex size-6 shrink-0 items-center justify-center rounded"
                      title={`${w.panes} 分屏`}
                      aria-label="展开分屏"
                    >
                      <ChevronRight className={cn('size-4 transition-transform', expanded === w.index && 'rotate-90')} />
                    </button>
                  )}
                </>
              )}
            </div>
            {expanded === w.index && (
              <div className="mb-1 ml-5 flex flex-col border-l pl-1">
                {panes.map((p) => (
                  <div key={p.index} className={cn('group flex items-center rounded-md', current === w.index && currentPane === p.index && 'bg-accent')}>
                    <button onClick={() => pickPane(w.index, p.index)} className="hover:bg-accent flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]">
                      <span className="text-muted-foreground tabular-nums">{p.index}</span>
                      <span className="min-w-0 flex-1 truncate">{p.command || p.title || `pane ${p.index}`}</span>
                      {p.active && (
                        <span className="text-[11px]" style={{ color: 'var(--brand)' }}>
                          活动
                        </span>
                      )}
                    </button>
                    <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                      <IconBtn title="关闭分屏" bad onClick={() => run({ action: 'kill-pane', window: w.index, pane: p.index })}>
                        <X className="size-3.5" />
                      </IconBtn>
                    </div>
                  </div>
                ))}
                {!panes.length && <div className="text-muted-foreground px-2 py-1 text-xs">读取分屏…</div>}
              </div>
            )}
          </div>
        ))}
        {!wins.length && <div className="text-muted-foreground px-2 py-2 text-xs">读取窗口…</div>}
      </PopoverContent>
    </Popover>
  )
}

function IconBtn({ title, bad, onClick, children }: { title: string; bad?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded',
        bad ? 'text-muted-foreground hover:bg-[var(--bad-bg)] hover:text-[var(--bad)]' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
