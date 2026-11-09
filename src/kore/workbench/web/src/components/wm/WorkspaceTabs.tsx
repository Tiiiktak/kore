import { useState, type ReactNode } from 'react'
import { ChevronRight, Columns2, FolderOpen, Globe, Plus, Rows2, TerminalSquare, X } from 'lucide-react'
import { toast } from 'sonner'
import { StatusDot } from '@/components/StatusDot'
import { Hint } from '@/components/Hint'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useRosterCtx } from '@/lib/roster-context'
import { listWins, type Workspace } from '@/lib/wm/tree'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import { effectiveState, useSeenVersion } from '@/lib/seen'
import { NO_MACHINE, UNGROUPED, addGroup, isCollapsed, removeGroup, renameGroup, toggleCollapse, useTabGroups } from '@/lib/tabgroups'
import { buildNodes, emptyLabels, nodeName, nodeOrder } from '@/lib/kore'
import { cn } from '@/lib/utils'

interface Item {
  ws: Workspace
  i: number
}
interface Section {
  key: string
  label: string
  items: Item[]
  custom?: boolean // a user-defined group (gets rename / delete); false for machine / catch-alls
}

// Each tab = a workspace (one split layout). Label = a split-direction icon + the window titles
// joined by " | ". The strip is flat by default; with a grouping mode on (lib/tabgroups) the
// workspaces are bucketed under collapsible headers — by machine (derived) or by user-defined
// custom groups (assigned via each tab's right-click menu). Horizontal (top bar) or vertical
// (sidebar); grouping renders in both, differing only by flex direction.
export function WorkspaceTabs({ vertical = false, trailing }: { vertical?: boolean; trailing?: ReactNode }) {
  useWmVersion()
  useSeenVersion()
  const { roster, fetchedAt } = useRosterCtx()
  const tg = useTabGroups()
  const s = wmStore.get()
  const stage = s.view === 'stage'
  const visible = wmStore.visibleSessionKeys()
  const labels = roster?.labels || emptyLabels
  const nodes = buildNodes(roster?.nodes || [])
  const [editing, setEditing] = useState<string | null>(null) // custom-group id being renamed inline
  const [draft, setDraft] = useState('')

  // Aggregate a workspace's status from its terminal windows:
  // needs-you (waiting) > working (busy) > just-finished (done) > idle. '' = no terminal windows.
  const wsState = (ws: Workspace): string => {
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

  const tabInner = (ws: Workspace, i: number) => {
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
            const title = names.map((n) => n.title).join(' | ')
            const undo = wmStore.closeWs(ws.id)
            toast('已关闭工作区', { description: title, action: { label: '撤销', onClick: undo } })
          }}
          aria-label="关闭工作区"
          className={cn(
            'hover:bg-[var(--bad-bg)] hover:text-[var(--bad)] flex size-6 shrink-0 items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 touch:opacity-100',
            activeTab && 'opacity-100',
          )}
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }

  // In custom mode a tab's right-click menu moves it between groups (or makes a new one).
  const renderTab = (ws: Workspace, i: number) => {
    if (tg.mode !== 'custom') return tabInner(ws, i)
    return (
      <ContextMenu key={ws.id}>
        <ContextMenuTrigger asChild>{tabInner(ws, i)}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>移到分组</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {tg.groups.map((g) => (
                <ContextMenuCheckboxItem key={g.id} checked={ws.group === g.id} onSelect={() => wmStore.setWsGroup(ws.id, g.id)}>
                  {g.name}
                </ContextMenuCheckboxItem>
              ))}
              {tg.groups.length > 0 && <ContextMenuSeparator />}
              <ContextMenuItem
                onSelect={() => {
                  const name = `分组${tg.groups.length + 1}`
                  const id = addGroup(name)
                  wmStore.setWsGroup(ws.id, id)
                  setDraft(name)
                  setEditing(id)
                }}
              >
                新建分组…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {ws.group && <ContextMenuItem onSelect={() => wmStore.setWsGroup(ws.id, null)}>移出分组</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const sections = (): Section[] => {
    const list: Item[] = s.workspaces.map((ws, i) => ({ ws, i }))
    if (tg.mode === 'machine') {
      const by = new Map<string, Item[]>()
      for (const it of list) {
        const k = wmStore.wsMachine(it.ws) ?? NO_MACHINE
        let arr = by.get(k)
        if (!arr) by.set(k, (arr = []))
        arr.push(it)
      }
      return [...by.keys()]
        .sort((a, b) => (a === NO_MACHINE ? 1 : b === NO_MACHINE ? -1 : nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1))
        .map((k) => ({ key: k, label: k === NO_MACHINE ? '其他' : nodeName(k, nodes, labels), items: by.get(k)! }))
    }
    // custom: every group shows (even empty, so tabs can be dropped in), ungrouped last
    const secs: Section[] = tg.groups.map((g) => ({ key: g.id, label: g.name, items: [], custom: true }))
    const byId = new Map(secs.map((se) => [se.key, se]))
    const ungrouped: Item[] = []
    for (const it of list) {
      const g = it.ws.group
      if (g && byId.has(g)) byId.get(g)!.items.push(it)
      else ungrouped.push(it)
    }
    if (ungrouped.length) secs.push({ key: UNGROUPED, label: '未分组', items: ungrouped })
    return secs
  }

  const commitRename = () => {
    if (editing) renameGroup(editing, draft)
    setEditing(null)
  }

  const renderHeader = (sec: Section, collapsed: boolean) => {
    const label =
      editing === sec.key ? (
        <input
          autoFocus
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') setEditing(null)
          }}
          className="bg-background focus:ring-ring w-24 rounded px-1 text-xs outline-none focus:ring-1"
        />
      ) : (
        <span className="truncate">{sec.label}</span>
      )
    const header = (
      <button
        type="button"
        onClick={() => toggleCollapse(sec.key)}
        className={cn(
          'text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium',
          vertical ? 'w-full px-1 py-1' : 'bg-muted/50 shrink-0 rounded-md px-1.5 py-1',
        )}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-200', !collapsed && 'rotate-90')} />
        {label}
        <span className="opacity-60">{sec.items.length}</span>
      </button>
    )
    if (!sec.custom) return header
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              setDraft(sec.label)
              setEditing(sec.key)
            }}
          >
            重命名分组
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => removeGroup(sec.key)}>删除分组</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div
      className={cn(
        'min-w-0 items-center gap-1',
        vertical ? 'flex flex-col items-stretch' : 'flex flex-1 overflow-x-auto [scrollbar-width:none]',
      )}
    >
      {tg.mode === 'none'
        ? s.workspaces.map((ws, i) => renderTab(ws, i))
        : sections().map((sec) => {
            const collapsed = isCollapsed(sec.key)
            return (
              <div key={sec.key} className={cn(vertical ? 'flex flex-col items-stretch' : 'flex items-center')}>
                {renderHeader(sec, collapsed)}
                {/* Collapsible body: animates HEIGHT in the sidebar, WIDTH in the top bar
                    (horizontal collapse). The grid 0fr↔1fr trick eases to the content's natural
                    size and degrades to an instant show/hide where fr isn't animatable. */}
                <div
                  className={cn(
                    'grid transition-[grid-template-rows,grid-template-columns] duration-200 ease-out',
                    vertical ? (collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]') : collapsed ? 'grid-cols-[0fr]' : 'grid-cols-[1fr]',
                  )}
                >
                  <div
                    className={cn(
                      'min-h-0 min-w-0 overflow-hidden',
                      vertical ? 'flex flex-col items-stretch gap-1 pt-1' : 'flex items-center gap-1 pl-1',
                    )}
                  >
                    {sec.items.map(({ ws, i }) => renderTab(ws, i))}
                  </div>
                </div>
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
