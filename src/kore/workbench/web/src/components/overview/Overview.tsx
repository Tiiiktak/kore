import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SessionCard } from './SessionCard'
import { StatusDot } from '@/components/StatusDot'
import { NewSessionDialog } from './NewSessionDialog'
import { AddMachineDialog } from './AddMachineDialog'
import { AdoptDialog } from './AdoptDialog'
import { RenameDialog, type RenameTarget } from './RenameDialog'
import { useRosterCtx } from '@/lib/roster-context'
import { useStars } from '@/hooks/useStars'
import { effectiveState, useSeenVersion } from '@/lib/seen'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import {
  STATE_LABEL,
  buildNodes,
  emptyLabels,
  nodeName,
  nodeOrder,
  sessKey,
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
  const { roster, loading, error, refreshing, refresh } = useRosterCtx()
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

  const openSession = (s: Session) => onOpen({ session: s, labels, prefix, nodes })

  // group consecutive rows by node for section headers
  const groups: Array<{ ip: string; rows: Session[] }> = []
  for (const s of rows) {
    const last = groups[groups.length - 1]
    if (last && last.ip === s.node_ip) last.rows.push(s)
    else groups.push({ ip: s.node_ip, rows: [s] })
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 p-4">
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

      <div className="bg-card flex min-h-0 flex-1 flex-col rounded-xl border shadow-sm">
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

        <ScrollArea className="min-h-0 flex-1">
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
                      displayState={effectiveState(s, visible)}
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
        </ScrollArea>
      </div>
      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} roster={roster} onCreated={refresh} />
      <AddMachineDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <AdoptDialog open={adoptOpen} onOpenChange={setAdoptOpen} roster={roster} onAdopted={refresh} />
      <RenameDialog target={rename} onOpenChange={(v) => !v && setRename(null)} onSaved={refresh} />
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
        active ? 'bg-card text-foreground border shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-accent',
      )}
    >
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
      <span>{label}</span>
      {count != null && <span className="text-muted-foreground tabular-nums">{count}</span>}
    </button>
  )
}

function GroupHeader({
  self,
  name,
  host,
  ip,
  count,
  onRename,
}: {
  self: boolean
  name: string
  host: string
  ip: string
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
      <span className="ml-auto shrink-0 tabular-nums">{count} 个</span>
    </div>
  )
}
