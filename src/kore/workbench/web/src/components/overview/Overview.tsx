import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleFadingArrowUp, Plus, RefreshCw, RotateCw, Server } from 'lucide-react'
import { toast } from 'sonner'
import { kNode, type NodeMetrics } from '@/lib/api'
import { useSysinfo } from '@/hooks/useSysinfo'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SessionCard } from './SessionCard'
import { StatusDot } from '@/components/StatusDot'
import { NewSessionDialog } from './NewSessionDialog'
import { AddMachineDialog } from './AddMachineDialog'
import { AdoptDialog } from './AdoptDialog'
import { RenameDialog, type RenameTarget } from './RenameDialog'
import { useRosterCtx } from '@/lib/roster-context'
import { useStars } from '@/hooks/useStars'
import { effectiveState, markActed, useSeenVersion } from '@/lib/seen'
import { useWmVersion, wmStore } from '@/lib/wm/store'
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

export function Overview({ onOpen }: { onOpen: (p: OpenPayload) => void }) {
  const { roster, loading, error, refreshing, refresh, fetchedAt } = useRosterCtx()
  const sysinfo = useSysinfo()
  const { stars, toggle } = useStars()
  useSeenVersion()
  useWmVersion()
  const visible = wmStore.visibleSessionKeys()
  const [filter, setFilter] = useState('') // '' = all, else node_ip
  const [newOpen, setNewOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [rename, setRename] = useState<RenameTarget | null>(null)

  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo<Record<string, NodeView>>(() => buildNodes(roster?.nodes || []), [roster])

  // star-pinned stable sort, then group by node in node order
  const rows = useMemo(() => {
    const all = (roster?.sessions || []).slice()
    all.sort((a, b) => {
      const sa = stars.has(sessKey(a)) ? 0 : 1
      const sb = stars.has(sessKey(b)) ? 0 : 1
      if (sa !== sb) return sa - sb
      const na = nodeOrder(a.node_ip, nodes)
      const nb = nodeOrder(b.node_ip, nodes)
      return na < nb ? -1 : na > nb ? 1 : 0
    })
    return filter ? all.filter((s) => s.node_ip === filter) : all
  }, [roster, stars, nodes, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of roster?.sessions || []) c[s.node_ip] = (c[s.node_ip] || 0) + 1
    return c
  }, [roster])

  const stateCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of roster?.sessions || []) c[s.state] = (c[s.state] || 0) + 1
    return c
  }, [roster])

  const nodeIps = useMemo(
    () => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)),
    [nodes],
  )

  const openSession = (s: Session) => {
    // "进去处理" a waiting session: stop its blink now, and force a fresh rescan so the real
    // state (busy/idle once you've answered, or still waiting if the prompt's up) lands fast
    // instead of waiting out the 10s cached poll.
    if (effectiveState(s, visible, fetchedAt) === 'waiting') {
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

  const total = roster?.sessions?.length ?? 0

  return (
    // One page-level scroll: the KPI strip and chips scroll away with the content, so on mobile
    // the whole area is swipeable (not just the inner panel). Nothing is pinned at the top.
    <div className="h-full w-full overflow-y-auto">
      <div className="flex w-full flex-col gap-3 p-4">
      {/* KPI strip — the dashboard headline numbers, full-width flat tiles */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <KpiTile label="总会话" value={total} />
        <KpiTile label="需回复" value={stateCounts.waiting || 0} tone={stateCounts.waiting ? 'waiting' : undefined} />
        <KpiTile label="运行中" value={stateCounts.busy || 0} tone={stateCounts.busy ? 'busy' : undefined} />
        <KpiTile label="机器" value={nodeIps.length} />
      </div>

      {/* machine filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={filter === ''} onClick={() => setFilter('')} label="全部" count={roster?.sessions?.length} />
        {nodeIps.map((ip) => (
          <Chip
            key={ip}
            active={filter === ip}
            onClick={() => setFilter(ip)}
            label={nodeName(ip, nodes, labels)}
            count={counts[ip] || 0}
            dot={nodes[ip]?.color}
          />
        ))}
      </div>

      <div className="bg-card flex flex-col rounded-xl border">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">kore sessions</h2>
          <span className="text-muted-foreground text-xs">{roster?.sessions?.length ?? 0} 个</span>
          {(['busy', 'waiting'] as const).map((st) =>
            stateCounts[st] ? (
              <span key={st} className="flex items-center gap-1 text-xs">
                <StatusDot state={st} />
                <span className="text-muted-foreground">
                  {STATE_LABEL[st]} {stateCounts[st]}
                </span>
              </span>
            ) : null,
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setJoinOpen(true)}>
              <Server />
              添加机器
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAdoptOpen(true)}>
              已有 session
            </Button>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus />
              新建
            </Button>
          </div>
        </div>

        <div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5 p-3">
            {loading && <div className="text-muted-foreground col-span-full p-8 text-center text-sm">加载中…</div>}
            {error && (
              <div className="text-bad col-span-full m-2 rounded-md bg-[var(--bad-bg,transparent)] px-3 py-2 text-xs">
                {error}
              </div>
            )}
            {!loading &&
              groups.map((g) => (
                <div key={g.ip} className="contents">
                  <div className="col-span-full">
                    <GroupHeader
                      self={!!nodes[g.ip]?.self}
                      name={nodeName(g.ip, nodes, labels)}
                      host={(nodes[g.ip]?.hostname || '').split('.')[0]}
                      ip={g.ip}
                      agentStarted={nodes[g.ip]?.agentStarted}
                      sys={sysinfo[g.ip]}
                      board={roster?.version}
                      count={counts[g.ip] || 0}
                      onRename={() =>
                        setRename({ kind: 'node', key: g.ip, current: labels.nodes[g.ip]?.name || '', placeholder: g.ip })
                      }
                    />
                  </div>
                  {g.rows.map((s) => (
                    <SessionCard
                      key={sessKey(s)}
                      s={s}
                      displayState={effectiveState(s, visible, fetchedAt)}
                      labels={labels}
                      prefix={prefix}
                      starred={stars.has(sessKey(s))}
                      onToggleStar={toggle}
                      onOpen={openSession}
                      onChanged={refresh}
                      onRename={() =>
                        setRename({
                          kind: 'session',
                          key: s.node_ip + '/' + s.name,
                          current: labels.sessions[s.node_ip + '/' + s.name]?.name || '',
                          placeholder: s.name,
                        })
                      }
                    />
                  ))}
                </div>
              ))}
            {!loading && !error && rows.length === 0 && (
              <div className="text-muted-foreground col-span-full p-8 text-center text-sm">没有会话</div>
            )}
          </div>
        </div>
      </div>
      </div>
      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} roster={roster} onCreated={refresh} />
      <AddMachineDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <AdoptDialog open={adoptOpen} onOpenChange={setAdoptOpen} roster={roster} onAdopted={refresh} />
      <RenameDialog target={rename} onOpenChange={(v) => !v && setRename(null)} onSaved={refresh} />
    </div>
  )
}

function KpiTile({ label, value, tone }: { label: string; value: number; tone?: 'waiting' | 'busy' }) {
  return (
    <div className="bg-card flex flex-col gap-1 rounded-xl border px-4 py-3">
      <span
        className={cn(
          'text-2xl leading-none font-semibold tabular-nums',
          tone === 'waiting' && 'text-[var(--waiting)]',
          tone === 'busy' && 'text-[var(--busy)]',
        )}
      >
        {value}
      </span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
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

function pctTone(pct: number): string {
  return pct >= 90 ? 'text-[var(--bad)]' : pct >= 75 ? 'text-[var(--busy)]' : ''
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="bg-muted/70 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{children}</span>
    </span>
  )
}

// Compact per-machine metrics in the group header: load / mem / disk / gpu. Tinted blocks, no
// one-sided edges ([[kore-ui-no-one-sided-edges]]); value turns amber/red as usage climbs.
// Hidden on narrow screens — the header stays readable on mobile.
function SysStrip({ sys, board, self }: { sys?: NodeMetrics; board?: string; self?: boolean }) {
  if (!sys) return null
  const gpus = sys.gpus ?? []
  // Version chip is for CLIENT consistency; the board's own version lives in the top bar, and
  // its PATH `kore` can differ from the running build — so don't show/flag it on the self node.
  const ver = self ? undefined : sys.kore_version
  const stale = versionLt(ver, board)
  const has = sys.load1 != null || sys.mem_total_kb || sys.disk_total_kb || gpus.length || ver
  if (!has) return null
  const memPct =
    sys.mem_total_kb ? Math.round((100 * (sys.mem_total_kb - (sys.mem_avail_kb ?? 0))) / sys.mem_total_kb) : null
  const diskPct = sys.disk_total_kb ? Math.round((100 * (sys.disk_used_kb ?? 0)) / sys.disk_total_kb) : null
  const gpuAvg = gpus.length ? Math.round(gpus.reduce((a, g) => a + g.util, 0) / gpus.length) : null
  const loadRatio = sys.load1 != null && sys.cpus ? sys.load1 / sys.cpus : null
  const loadTone = loadRatio == null ? '' : loadRatio >= 1.5 ? 'text-[var(--bad)]' : loadRatio >= 1 ? 'text-[var(--busy)]' : ''
  return (
    <div className="hidden shrink-0 items-center gap-1 lg:flex">
      {sys.load1 != null && (
        <Metric label="负载">
          <span className={loadTone}>{sys.load1.toFixed(1)}</span>
          {sys.cpus ? <span className="text-muted-foreground">/{sys.cpus}</span> : null}
        </Metric>
      )}
      {memPct != null && (
        <Metric label="内存">
          <span className={pctTone(memPct)}>{memPct}%</span>
        </Metric>
      )}
      {diskPct != null && (
        <Metric label="磁盘">
          <span className={pctTone(diskPct)}>{diskPct}%</span>
        </Metric>
      )}
      {gpuAvg != null && (
        <Metric label="GPU">
          {gpus.length}·<span className={pctTone(gpuAvg)}>{gpuAvg}%</span>
        </Metric>
      )}
      {ver && (
        <span
          title={stale ? `版本落后，建议升级到 ${board}` : undefined}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] tabular-nums',
            stale ? 'bg-busy-bg text-[var(--busy)]' : 'bg-muted/70 text-muted-foreground',
          )}
        >
          {ver.startsWith('v') ? ver : 'v' + ver}
          {stale && <span>·旧</span>}
        </span>
      )}
    </div>
  )
}

function GroupHeader({
  self,
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
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold', self ? 'bg-[var(--claude)] text-white' : 'bg-[var(--idle)] text-white')}>
        {self ? 'server' : 'client'}
      </span>
      <button onClick={onRename} title="改机器备注名" className="text-foreground hover:bg-accent shrink-0 rounded px-1 font-semibold whitespace-nowrap">{name}</button>
      {host && <span className="hidden min-w-0 truncate sm:inline">{host}</span>}
      <span className="hidden shrink-0 font-mono sm:inline">{ip}</span>
      <SysStrip sys={sys} board={board} self={self} />
      <span className="ml-auto shrink-0 tabular-nums">{count} 个</span>
      <NodeActions self={self} ip={ip} agentStarted={agentStarted} />
    </div>
  )
}

// A two-step (arm → confirm) lifecycle button. The server builds the command; we only name the
// target. The node drops offline briefly as its agent/board is replaced — the roster poll shows
// it come back, so we don't block on the (possibly dropped) response.
// A privileged lifecycle action behind an EXPLICIT confirm: the icon button opens a small
// popover that spells out the consequence and offers 取消 / 确认 — never a one-click trigger.
function ConfirmAction({
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
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await run()
      onFired?.()
      toast(toastMsg, { description: '节点会短暂掉线重连，稍候自动恢复' })
      setOpen(false)
    } catch (err) {
      toast.error('操作失败', { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title={title}
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex shrink-0 items-center rounded px-1 py-0.5 transition-colors"
        >
          <Icon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">{title}</div>
          <p className="text-muted-foreground text-xs leading-relaxed">{desc}</p>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" size="sm" className="h-7" onClick={go} disabled={busy}>
              {busy ? '执行中…' : confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
        <span className="flex items-center gap-1 text-[11px] text-[var(--busy)]">
          <RotateCw className="size-3 animate-spin" />
          重启中…
        </span>
      )}
      {phase === 'done' && <span className="text-[11px] font-medium text-[var(--ok)]">已重启 ✓</span>}
      {phase === 'sent' && <span className="text-muted-foreground text-[11px]">已下发</span>}
      {!self && (
        <ConfirmAction
          icon={RotateCw}
          title="重启 agent"
          desc="重启这台机器的 kore agent。它会短暂掉线并自动重连；正在运行的 tmux / Claude 会话不受影响。"
          confirmLabel="重启"
          toastMsg="正在重启 agent"
          run={() => kNode('node', 'restart', { node_ip: ip })}
          onFired={startWatch}
        />
      )}
      <ConfirmAction
        icon={CircleFadingArrowUp}
        title={self ? '升级并重启 server' : '升级并重启该机器'}
        desc={
          self
            ? '拉取最新 kore 代码并重启本机板子。看板会短暂断开并自动重连；tmux / Claude 会话不受影响。'
            : '在这台机器上拉取最新 kore 代码并重启其 agent。期间它短暂掉线自动重连；tmux / Claude 会话不受影响。'
        }
        confirmLabel="升级并重启"
        toastMsg={self ? '正在升级并重启 server' : '正在升级并重启该机器'}
        run={() => (self ? kNode('server', 'upgrade') : kNode('node', 'upgrade', { node_ip: ip }))}
        onFired={self ? undefined : startWatch}
      />
    </div>
  )
}
