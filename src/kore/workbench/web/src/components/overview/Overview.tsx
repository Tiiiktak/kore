import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleFadingArrowUp, Import, Plus, RefreshCw, RotateCw, Server, TerminalSquare, X } from 'lucide-react'
import { toast } from 'sonner'
import { kNode, type NodeMetrics } from '@/lib/api'
import { useSysinfo } from '@/hooks/useSysinfo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ConfirmPopover } from '@/components/ConfirmPopover'
import { Hint } from '@/components/Hint'
import { SessionCard } from './SessionCard'
import { NewSessionDialog } from './NewSessionDialog'
import { AddMachineDialog } from './AddMachineDialog'
import { AdoptDialog } from './AdoptDialog'
import { RenameDialog } from './RenameDialog'
import { useRosterCtx } from '@/lib/roster-context'
import { useStars } from '@/hooks/useStars'
import { effectiveState, markActed, useSeenVersion } from '@/lib/seen'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import { setUi, useUi } from '@/lib/ui'
import {
  STATE_LABEL,
  buildNodes,
  emptyLabels,
  nodeName,
  nodeOrder,
  sessKey,
  versionLt,
  type NodeView,
} from '@/lib/kore'
import type { Labels, Session } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface OpenPayload {
  session: Session
  labels: Labels
  prefix: string
  nodes: Record<string, NodeView>
}

// The KPI tiles double as the state filter. '' = all states.
type StFilter = '' | 'waiting' | 'busy' | 'done'
const ST_TILES: Array<{ st: Exclude<StFilter, ''>; label: string; tone: string }> = [
  { st: 'waiting', label: STATE_LABEL.waiting, tone: 'text-st-waiting' },
  { st: 'busy', label: STATE_LABEL.busy, tone: 'text-st-busy' },
  { st: 'done', label: STATE_LABEL.done, tone: 'text-st-done' },
]

export function Overview({ onOpen }: { onOpen: (p: OpenPayload) => void }) {
  const { roster, loading, error, refreshing, refresh, fetchedAt } = useRosterCtx()
  const sysinfo = useSysinfo()
  const { stars, toggle } = useStars()
  const ui = useUi()
  useSeenVersion()
  useWmVersion()
  const visible = wmStore.visibleSessionKeys()
  const [filter, setFilter] = useState('') // '' = all machines, else node_ip
  const [stFilter, setStFilter] = useState<StFilter>('')

  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo<Record<string, NodeView>>(() => buildNodes(roster?.nodes || []), [roster])
  const all = roster?.sessions || []
  // the state each card actually shows (acted-on waiting → busy, unseen idle → done); counts and
  // the state filter use it too, so a tile never disagrees with the dots below it
  const shownState = (s: Session) => effectiveState(s, visible, fetchedAt)

  // star-pinned stable sort, then group by node in node order
  const rows = useMemo(() => {
    const out = all.slice()
    out.sort((a, b) => {
      const sa = stars.has(sessKey(a)) ? 0 : 1
      const sb = stars.has(sessKey(b)) ? 0 : 1
      if (sa !== sb) return sa - sb
      const na = nodeOrder(a.node_ip, nodes)
      const nb = nodeOrder(b.node_ip, nodes)
      return na < nb ? -1 : na > nb ? 1 : 0
    })
    return out.filter((s) => (!filter || s.node_ip === filter) && (!stFilter || shownState(s) === stFilter))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, stars, nodes, filter, stFilter, fetchedAt, visible.size])

  const counts: Record<string, number> = {}
  for (const s of all) counts[s.node_ip] = (counts[s.node_ip] || 0) + 1
  const stateCounts: Record<string, number> = {}
  for (const s of all) {
    const st = shownState(s)
    stateCounts[st] = (stateCounts[st] || 0) + 1
  }

  const nodeIps = useMemo(
    () => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)),
    [nodes],
  )

  const openSession = (s: Session) => {
    // "进去处理" a waiting session: stop its blink now, and force a fresh rescan so the real
    // state (busy/idle once you've answered, or still waiting if the prompt's up) lands fast
    // instead of waiting out the 10s cached poll.
    if (shownState(s) === 'waiting') {
      markActed(sessKey(s))
      refresh()
    }
    onOpen({ session: s, labels, prefix, nodes })
  }

  // group consecutive rows by node for section headers
  const groups: Array<{ ip: string; rows: Session[] }> = []
  for (const s of rows) {
    const last = groups[groups.length - 1]
    if (last && last.ip === s.node_ip) last.rows.push(s)
    else groups.push({ ip: s.node_ip, rows: [s] })
  }

  const filtered = !!(filter || stFilter)
  const clearFilters = () => {
    setFilter('')
    setStFilter('')
  }

  return (
    // One page-level scroll: the KPI strip and chips scroll away with the content, so on mobile
    // the whole area is swipeable (not just the inner panel). Nothing is pinned at the top.
    <div className="h-full w-full overflow-y-auto">
      <div className="flex w-full flex-col gap-3 p-4">
        {/* KPI strip — the headline numbers; each tile is also the state filter (click again = all) */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <KpiTile label="全部 session" value={all.length} active={!stFilter} onClick={() => setStFilter('')} />
          {ST_TILES.map((t) => (
            <KpiTile
              key={t.st}
              label={t.label}
              value={stateCounts[t.st] || 0}
              tone={stateCounts[t.st] ? t.tone : undefined}
              active={stFilter === t.st}
              onClick={() => setStFilter(stFilter === t.st ? '' : t.st)}
            />
          ))}
        </div>

        {/* machine filter chips, then the add-machine entry at the end of the same row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={filter === ''} onClick={() => setFilter('')} label="所有机器" />
          {nodeIps.map((ip) => (
            <Chip
              key={ip}
              active={filter === ip}
              onClick={() => setFilter(filter === ip ? '' : ip)}
              label={nodeName(ip, nodes, labels)}
              count={counts[ip] || 0}
              dot={nodes[ip]?.color}
            />
          ))}
          <button
            onClick={() => setUi({ addMachine: true })}
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors"
          >
            <Plus className="size-3.5" />
            添加机器
          </button>
        </div>

        <div className="bg-card flex flex-col rounded-xl border">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Sessions</h2>
            {filtered && (
              <button
                onClick={clearFilters}
                className="text-muted-foreground hover:text-foreground bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1.5 pl-2 text-xs"
              >
                {[stFilter && STATE_LABEL[stFilter], filter && nodeName(filter, nodes, labels)].filter(Boolean).join(' · ')}
                <span className="tabular-nums">{rows.length}</span>
                <X className="size-3" />
              </button>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Hint label="立即刷新">
                <Button variant="ghost" size="icon" className="size-8" onClick={refresh} disabled={refreshing} aria-label="刷新">
                  <RefreshCw className={cn(refreshing && 'animate-spin')} />
                </Button>
              </Hint>
              <NewButton />
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5 p-3">
            {loading && !roster && <SkeletonCards />}
            {error && (
              <div className="text-bad bg-bad-bg col-span-full m-2 rounded-md px-3 py-2 text-xs">{error}</div>
            )}
            {!loading &&
              groups.map((g) => (
                <div key={g.ip} className="contents">
                  <div className="col-span-full">
                    <GroupHeader
                      self={!!nodes[g.ip]?.self}
                      color={nodes[g.ip]?.color}
                      name={nodeName(g.ip, nodes, labels)}
                      host={(nodes[g.ip]?.hostname || '').split('.')[0]}
                      ip={g.ip}
                      agentStarted={nodes[g.ip]?.agentStarted}
                      sys={sysinfo[g.ip]}
                      board={roster?.version}
                      count={counts[g.ip] || 0}
                      onRename={() =>
                        setUi({ rename: { kind: 'node', key: g.ip, current: labels.nodes[g.ip]?.name || '', placeholder: g.ip } })
                      }
                    />
                  </div>
                  {g.rows.map((s) => (
                    <SessionCard
                      key={sessKey(s)}
                      s={s}
                      displayState={shownState(s)}
                      labels={labels}
                      prefix={prefix}
                      starred={stars.has(sessKey(s))}
                      onToggleStar={toggle}
                      onOpen={openSession}
                      onChanged={refresh}
                      onRename={() =>
                        setUi({
                          rename: {
                            kind: 'session',
                            key: s.node_ip + '/' + s.name,
                            current: labels.sessions[s.node_ip + '/' + s.name]?.name || '',
                            placeholder: s.name,
                          },
                        })
                      }
                    />
                  ))}
                </div>
              ))}
            {!loading && !error && rows.length === 0 && (filtered && all.length ? <NoMatch onClear={clearFilters} /> : <EmptyState />)}
          </div>
        </div>
      </div>
      <NewSessionDialog open={ui.newSession} onOpenChange={(v) => setUi({ newSession: v })} roster={roster} />
      <AddMachineDialog open={ui.addMachine} onOpenChange={(v) => setUi({ addMachine: v })} />
      <AdoptDialog open={ui.adopt} onOpenChange={(v) => setUi({ adopt: v })} roster={roster} onAdopted={refresh} />
      <RenameDialog target={ui.rename} onOpenChange={(v) => !v && setUi({ rename: null })} onSaved={refresh} />
    </div>
  )
}

// The primary action, with the less common "adopt an existing tmux session" folded under it.
function NewButton() {
  return (
    <div className="flex items-center">
      <Button size="sm" className="rounded-r-none" onClick={() => setUi({ newSession: true })}>
        <Plus />
        新建 session
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" className="border-primary-foreground/20 rounded-l-none border-l px-1.5" aria-label="更多新建方式">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setUi({ newSession: true })}>
            <Plus /> 新建 session
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setUi({ adopt: true })}>
            <Import /> 接管已有 tmux session…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Fixed-height placeholders while the first roster loads, so the grid doesn't jump.
function SkeletonCards() {
  return (
    <>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="bg-muted/60 h-[128px] animate-pulse rounded-lg" />
      ))}
    </>
  )
}

// First run / no sessions anywhere: the three ways to get one, right here.
function EmptyState() {
  return (
    <div className="col-span-full flex flex-col items-center gap-3 px-4 py-12 text-center">
      <TerminalSquare className="text-muted-foreground size-8" />
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium">还没有 session</div>
        <div className="text-muted-foreground text-xs">新建一个，或把机器上已有的 tmux session 纳入管理。</div>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={() => setUi({ newSession: true })}>
          <Plus /> 新建 session
        </Button>
        <Button variant="outline" size="sm" onClick={() => setUi({ adopt: true })}>
          <Import /> 接管已有 session
        </Button>
        <Button variant="outline" size="sm" onClick={() => setUi({ addMachine: true })}>
          <Server /> 添加机器
        </Button>
      </div>
    </div>
  )
}

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <div className="text-muted-foreground col-span-full flex flex-col items-center gap-2 p-8 text-sm">
      没有符合筛选的 session
      <Button variant="outline" size="sm" onClick={onClear}>
        清除筛选
      </Button>
    </div>
  )
}

function KpiTile({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number
  tone?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'bg-card flex flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-colors',
        active ? 'border-ring' : 'hover:bg-accent/40',
      )}
    >
      <span className={cn('text-2xl leading-none font-semibold tabular-nums', tone)}>{value}</span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </button>
  )
}

function Chip({
  active,
  onClick,
  label,
  count,
  dot,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  dot?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
        active ? 'bg-card text-foreground border' : 'text-muted-foreground hover:text-foreground hover:bg-accent',
      )}
    >
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
      <span>{label}</span>
      {count != null && <span className="text-muted-foreground tabular-nums">{count}</span>}
    </button>
  )
}

// ---- per-machine health ---------------------------------------------------------------------

type Level = 0 | 1 | 2 // ok / warn / bad
const pctLevel = (pct: number): Level => (pct >= 90 ? 2 : pct >= 75 ? 1 : 0)
const loadLevel = (ratio: number): Level => (ratio >= 1.5 ? 2 : ratio >= 1 ? 1 : 0)
const LEVEL_TEXT = ['', 'text-warn', 'text-bad'] as const

interface Health {
  items: Array<{ label: string; value: string; sub?: string; level: Level }>
  level: Level
}

function health(sys?: NodeMetrics): Health | null {
  if (!sys) return null
  const items: Health['items'] = []
  if (sys.load1 != null) {
    const ratio = sys.cpus ? sys.load1 / sys.cpus : 0
    items.push({ label: '负载', value: sys.load1.toFixed(1), sub: sys.cpus ? '/' + sys.cpus : undefined, level: loadLevel(ratio) })
  }
  if (sys.mem_total_kb) {
    const pct = Math.round((100 * (sys.mem_total_kb - (sys.mem_avail_kb ?? 0))) / sys.mem_total_kb)
    items.push({ label: '内存', value: pct + '%', level: pctLevel(pct) })
  }
  if (sys.disk_total_kb) {
    const pct = Math.round((100 * (sys.disk_used_kb ?? 0)) / sys.disk_total_kb)
    items.push({ label: '磁盘', value: pct + '%', level: pctLevel(pct) })
  }
  const gpus = sys.gpus ?? []
  if (gpus.length) {
    const avg = Math.round(gpus.reduce((a, g) => a + g.util, 0) / gpus.length)
    items.push({ label: 'GPU', value: avg + '%', sub: `×${gpus.length}`, level: pctLevel(avg) })
  }
  if (!items.length) return null
  return { items, level: Math.max(...items.map((i) => i.level)) as Level }
}

function Metric({ item }: { item: Health['items'][number] }) {
  return (
    <span className="bg-muted/70 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{item.label}</span>
      <span className="tabular-nums">
        <span className={LEVEL_TEXT[item.level]}>{item.value}</span>
        {item.sub && <span className="text-muted-foreground">{item.sub}</span>}
      </span>
    </span>
  )
}

// Machine metrics in the group header. Wide screens: the full load / mem / disk / gpu strip
// (values turn amber/red as usage climbs). Narrow screens: one health dot that opens the same
// numbers in a popover — and once anything crosses a threshold it says so in words.
// Tinted blocks, no one-sided edges ([[kore-ui-no-one-sided-edges]]).
function SysStrip({ sys }: { sys?: NodeMetrics }) {
  const h = health(sys)
  if (!h) return null
  const dot = ['var(--ok)', 'var(--warn)', 'var(--bad)'][h.level]
  return (
    <>
      <div className="hidden shrink-0 items-center gap-1 lg:flex">
        {h.items.map((it) => (
          <Metric key={it.label} item={it} />
        ))}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            aria-label="机器资源"
            className="hover:bg-accent flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] lg:hidden"
          >
            <span className="size-2 rounded-full" style={{ background: dot }} />
            {h.level > 0 && <span className={LEVEL_TEXT[h.level]}>{h.level === 2 ? '资源告急' : '资源偏高'}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto">
          <div className="flex flex-wrap gap-1">
            {h.items.map((it) => (
              <Metric key={it.label} item={it} />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}

// Client build vs the board's. The board's own version lives in the top bar, and its PATH `kore`
// can differ from the running build — so it isn't shown/flagged on the self node.
function VersionChip({ ver, board }: { ver?: string; board?: string }) {
  if (!ver) return null
  const stale = versionLt(ver, board)
  return (
    <span
      title={stale ? `版本落后，建议升级到 ${board}` : undefined}
      className={cn(
        'hidden shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] tabular-nums sm:inline-flex',
        stale ? 'bg-warn-bg text-warn' : 'bg-muted/70 text-muted-foreground',
      )}
    >
      {ver.startsWith('v') ? ver : 'v' + ver}
      {stale && <span>·旧</span>}
    </span>
  )
}

function GroupHeader({
  self,
  color,
  name,
  host,
  ip,
  agentStarted,
  sys,
  board,
  count,
  onRename,
}: {
  self: boolean
  color?: string
  name: string
  host: string
  ip: string
  agentStarted?: number
  sys?: NodeMetrics
  board?: string
  count: number
  onRename: () => void
}) {
  return (
    <div className="text-muted-foreground bg-card sticky top-0 z-[1] flex items-center gap-2 overflow-hidden px-4 pt-3.5 pb-1.5 text-[12px]">
      {/* tinted role chip in the machine's colour, foreground text — legible in both themes */}
      <span
        className="text-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
        style={{ background: `color-mix(in srgb, ${color || 'var(--muted-foreground)'} 22%, transparent)` }}
      >
        {self ? 'server' : 'client'}
      </span>
      <button onClick={onRename} title="改机器备注名" className="text-foreground hover:bg-accent shrink-0 rounded px-1 font-semibold whitespace-nowrap">
        {name}
      </button>
      {host && <span className="hidden min-w-0 truncate sm:inline">{host}</span>}
      <span className="hidden shrink-0 font-mono sm:inline">{ip}</span>
      <SysStrip sys={sys} />
      {!self && <VersionChip ver={sys?.kore_version} board={board} />}
      <span className="ml-auto shrink-0 tabular-nums">{count} 个</span>
      <NodeActions self={self} ip={ip} agentStarted={agentStarted} />
    </div>
  )
}

// A privileged lifecycle action: an icon button that opens the shared ConfirmPopover. The server
// builds the command; we only name the target. The node drops offline briefly as its agent/board
// is replaced — the roster poll shows it come back, so we don't block on the response.
function NodeAction({
  icon: Icon,
  title,
  desc,
  confirmLabel,
  toastMsg,
  run,
  onFired,
}: {
  icon: typeof RotateCw
  title: string
  desc: string
  confirmLabel: string
  toastMsg: string
  run: () => Promise<unknown>
  onFired?: () => void
}) {
  return (
    <ConfirmPopover
      hint={title}
      title={title}
      desc={desc}
      confirmLabel={confirmLabel}
      run={async () => {
        await run()
        onFired?.()
        toast(toastMsg, { description: '这台机器会短暂掉线重连，稍候自动恢复' })
      }}
    >
      <button
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent flex shrink-0 items-center rounded px-1 py-0.5 transition-colors"
      >
        <Icon className="size-3.5" />
      </button>
    </ConfirmPopover>
  )
}

// Per-machine lifecycle controls in the group header: a client can be restarted or upgraded;
// the server (self) can be upgraded-and-restarted. All go through the WB-gated node endpoints.
// After a client action we WATCH the node's agent_started: it only changes when the agent
// process actually bounced, so "重启中…" → "已重启 ✓" is real confirmation (the restart is too
// fast to see otherwise). We force-refresh the roster during the watch so that signal lands.
function NodeActions({ self, ip, agentStarted }: { self: boolean; ip: string; agentStarted?: number }) {
  const { refresh } = useRosterCtx()
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  // 'watching' only when the node reports agent_started (new client) so a real bounce can be
  // confirmed; 'sent' is the honest fallback for an old client that never reports it (or a
  // watch that timed out) — we dispatched the command but can't prove the restart.
  const [phase, setPhase] = useState<'idle' | 'watching' | 'done' | 'sent'>('idle')
  const before = useRef<number | null>(null)

  // Poll (force) while watching, capped so a node that never comes back doesn't poll forever.
  useEffect(() => {
    if (phase !== 'watching') return
    let n = 0
    const iv = setInterval(() => {
      refreshRef.current()
      if (++n >= 18) setPhase('sent') // ~36s without a changed agent_started → just "已下发"
    }, 2000)
    return () => clearInterval(iv)
  }, [phase])

  // agent_started changed → the agent really bounced.
  useEffect(() => {
    if (phase === 'watching' && agentStarted != null && before.current != null && agentStarted !== before.current)
      setPhase('done')
  }, [phase, agentStarted])

  // auto-clear the transient confirmations
  useEffect(() => {
    if (phase === 'done' || phase === 'sent') {
      const to = setTimeout(() => setPhase('idle'), phase === 'done' ? 2500 : 3000)
      return () => clearTimeout(to)
    }
  }, [phase])

  const startWatch = () => {
    refreshRef.current()
    if (agentStarted == null) {
      setPhase('sent') // old client: no started_at to watch — show 已下发, don't hang on 重启中
      return
    }
    before.current = agentStarted
    setPhase('watching')
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {phase === 'watching' && (
        <span className="text-warn flex items-center gap-1 text-[11px]">
          <RotateCw className="size-3 animate-spin" />
          重启中…
        </span>
      )}
      {phase === 'done' && <span className="text-ok text-[11px] font-medium">已重启 ✓</span>}
      {phase === 'sent' && <span className="text-muted-foreground text-[11px]">已下发</span>}
      {!self && (
        <NodeAction
          icon={RotateCw}
          title="重启 agent"
          desc="重启这台机器的 kore agent。它会短暂掉线并自动重连；正在运行的 tmux / Claude session 不受影响。"
          confirmLabel="重启"
          toastMsg="正在重启 agent"
          run={() => kNode('node', 'restart', { node_ip: ip })}
          onFired={startWatch}
        />
      )}
      <NodeAction
        icon={CircleFadingArrowUp}
        title={self ? '升级并重启 server' : '升级并重启该 client'}
        desc={
          self
            ? '拉取最新 kore 代码并重启本机板子。看板会短暂断开并自动重连；tmux / Claude session 不受影响。'
            : '在这台机器上拉取最新 kore 代码并重启其 agent。期间它短暂掉线自动重连；tmux / Claude session 不受影响。'
        }
        confirmLabel="升级并重启"
        toastMsg={self ? '正在升级并重启 server' : '正在升级并重启该 client'}
        run={() => (self ? kNode('server', 'upgrade') : kNode('node', 'upgrade', { node_ip: ip }))}
        onFired={self ? undefined : startWatch}
      />
    </div>
  )
}
