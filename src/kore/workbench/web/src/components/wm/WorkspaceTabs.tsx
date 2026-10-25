import type { ReactNode } from 'react'
import { Columns2, FolderOpen, Globe, Plus, Rows2, TerminalSquare, X } from 'lucide-react'
import { StatusDot } from '@/components/StatusDot'
import { Hint } from '@/components/Hint'
import { useRosterCtx } from '@/lib/roster-context'
import { listWins } from '@/lib/wm/tree'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import { effectiveState, useSeenVersion } from '@/lib/seen'
import { cn } from '@/lib/utils'

// Each tab = a workspace (one split layout). Label = a split-direction icon + the window
// titles joined by " | " (e.g. ▣ kore | rsi). Horizontal (top bar) or vertical (sidebar).
export function WorkspaceTabs({ vertical = false, trailing }: { vertical?: boolean; trailing?: ReactNode }) {
  useWmVersion()
  useSeenVersion()
  const { roster, fetchedAt } = useRosterCtx()
  const s = wmStore.get()
  const stage = s.view === 'stage'
  const visible = wmStore.visibleSessionKeys()
  // Aggregate a workspace's status from its terminal windows:
  // needs-you (waiting) > working (busy) > just-finished (done) > idle. '' = no terminal windows.
  const wsState = (ws: (typeof s.workspaces)[number]): string => {
    let busy = false
    let done = false
    let any = false
    for (const id of listWins(ws.root)) {
      const w = s.wins[id]
      if (!(w && w.type === 'term' && w.state.node_ip)) continue
      const sess = roster?.sessions?.find((x) => x.node_ip === w.state.node_ip && x.name === w.state.name)
      if (!sess) continue
      any = true
      const st = effectiveState(sess, visible, fetchedAt)
      if (st === 'waiting') return 'waiting'
      if (st === 'busy') busy = true
      if (st === 'done') done = true
    }
    return busy ? 'busy' : done ? 'done' : any ? 'idle' : ''
  }

  return (
    <div
      className={cn(
        'min-w-0 items-center gap-1',
        vertical ? 'flex flex-col items-stretch' : 'flex flex-1 overflow-x-auto [scrollbar-width:none]',
      )}
    >
      {s.workspaces.map((ws, i) => {
        const { dir, names } = wmStore.wsSummary(ws)
        const activeTab = stage && i === s.cur
        return (
          <div
            key={ws.id}
            data-flip={`nav-tab-${ws.id}`}
            role="tab"
            tabIndex={0}
            aria-selected={activeTab}
            onClick={() => wmStore.switchWs(i)}
            onKeyDown={(e) => e.key === 'Enter' && wmStore.switchWs(i)}
            className={cn(
              'group flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2.5 text-sm transition-all duration-200',
              vertical ? 'w-full' : 'max-w-[220px]',
              activeTab ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {wsState(ws) && <StatusDot state={wsState(ws)} className="mr-0.5" />}
            {dir === 'row' ? (
              <Columns2 className="size-4 shrink-0 opacity-70" />
            ) : dir === 'col' ? (
              <Rows2 className="size-4 shrink-0 opacity-70" />
            ) : names[0]?.type === 'web' ? (
              <Globe className="size-4 shrink-0 opacity-60" />
            ) : names[0]?.type === 'files' ? (
              <FolderOpen className="size-4 shrink-0 opacity-60" />
            ) : (
              <TerminalSquare className="size-4 shrink-0 opacity-60" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {names.map((n, j) => (
                <span key={j}>
                  {j > 0 && <span className="text-muted-foreground px-0.5">|</span>}
                  {n.title}
                </span>
              ))}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                wmStore.closeWs(ws.id)
              }}
              aria-label="关闭工作区"
              className="hover:bg-[var(--bad-bg)] hover:text-[var(--bad)] flex size-6 shrink-0 items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 aria-[selected=true]:opacity-100"
            >
              <X className="size-4" />
            </button>
          </div>
        )
      })}
      {/* icon-only (horizontal) needs a hint; the vertical form already shows the label as text */}
      <Hint label={vertical ? '' : '新建工作区'}>
        <button
          data-flip="nav-newws"
          onClick={() => wmStore.newBlankWorkspace()}
          aria-label="新建工作区"
          className={cn(
            'text-muted-foreground hover:bg-accent hover:text-foreground flex h-9 shrink-0 items-center justify-center rounded-md text-sm',
            vertical ? 'w-full justify-start gap-2.5 pl-2.5' : 'w-9',
          )}
        >
          <Plus className="size-4" />
          {vertical && <span>新建工作区</span>}
        </button>
      </Hint>
      {trailing}
    </div>
  )
}
