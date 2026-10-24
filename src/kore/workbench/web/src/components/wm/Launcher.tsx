import { useEffect, useMemo, useState } from 'react'
import { useRosterCtx } from '@/lib/roster-context'
import { apiGet } from '@/lib/api'
import { wmStore } from '@/lib/wm/store'
import { listWins } from '@/lib/wm/tree'
import {
  buildNodes,
  emptyLabels,
  nodeName,
  nodeOrder,
  sessName,
  sessKey,
  type NodeView,
} from '@/lib/kore'
import { normUrl } from '@/lib/wm/web'
import { StatusDot } from '@/components/StatusDot'
import { cn } from '@/lib/utils'

type Tab = 'term' | 'web' | 'files'

// Empty-window picker (also reused inside the title Switch popover). Fills the given window.
export function Launcher({ winId, compact = false, onPicked }: { winId: string; compact?: boolean; onPicked?: () => void }) {
  const { roster } = useRosterCtx()
  const [tab, setTab] = useState<Tab>('term')
  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo<Record<string, NodeView>>(() => buildNodes(roster?.nodes || []), [roster])

  const pick = () => onPicked?.()

  return (
    <div className={cn('flex flex-col items-stretch gap-3', compact ? 'p-0' : 'bg-card absolute inset-0 items-center justify-center p-5')}>
      <div className={cn('flex flex-col gap-3', compact ? 'w-full' : 'w-[min(460px,100%)]')}>
        <div className="bg-muted mx-auto flex items-center gap-0.5 rounded-lg p-0.5">
          {(['term', 'web', 'files'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-4 py-1.5 text-xs transition-colors',
                tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'term' ? '终端' : t === 'web' ? '浏览器' : '文件'}
            </button>
          ))}
        </div>
        {tab === 'term' && <TermPicker winId={winId} prefix={prefix} labels={labels} nodes={nodes} onPicked={pick} />}
        {tab === 'web' && <WebPicker winId={winId} onPicked={pick} />}
        {tab === 'files' && <FilesPicker winId={winId} nodes={nodes} labels={labels} onPicked={pick} />}
      </div>
    </div>
  )
}

function TermPicker({
  winId,
  prefix,
  labels,
  nodes,
  onPicked,
}: {
  winId: string
  prefix: string
  labels: any
  nodes: Record<string, NodeView>
  onPicked: () => void
}) {
  const { roster } = useRosterCtx()
  const [q, setQ] = useState('')
  const rows = roster?.sessions || []
  const openKeys = useMemo(() => {
    const ws = wmStore.active()
    const s = new Set<string>()
    if (ws) for (const id of listWins(ws.root)) if (wmStore.termKey(id)) s.add(wmStore.termKey(id))
    return s
  }, [])
  const shown = q
    ? rows.filter((s) => (sessName(s, labels, prefix) + ' ' + s.name + ' ' + nodeName(s.node_ip, nodes, labels)).toLowerCase().includes(q.toLowerCase()))
    : rows

  const open = (s: any) => {
    const key = sessKey(s)
    const ws = wmStore.active()
    const there = ws && listWins(ws.root).find((id) => id !== winId && wmStore.termKey(id) === key)
    if (there) wmStore.focus(there)
    else
      wmStore.setWin(winId, 'term', {
        node_ip: s.node_ip,
        name: s.name,
        writable: s.writable,
        label: sessName(s, labels, prefix),
        node: nodeName(s.node_ip, nodes, labels),
      })
    onPicked()
  }

  if (!rows.length) return <div className="text-muted-foreground py-6 text-center text-xs">还没有会话。回到总览新建一个。</div>
  return (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        placeholder="过滤会话 / 机器"
        aria-label="过滤会话"
        className="bg-card text-foreground h-8 w-full rounded-md px-3 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
      />
      <div className="flex max-h-[46vh] flex-col gap-0.5 overflow-auto">
        {shown.map((s) => (
          <button
            key={sessKey(s)}
            onClick={() => open(s)}
            className="hover:bg-accent flex h-8 items-center gap-2 rounded-md px-3 text-left text-[14px]"
          >
            <StatusDot state={s.state} />
            <span className="min-w-0 truncate">{sessName(s, labels, prefix)}</span>
            <span className="text-muted-foreground text-xs whitespace-nowrap">{nodeName(s.node_ip, nodes, labels)}</span>
            {openKeys.has(sessKey(s)) && <span className="text-muted-foreground ml-auto text-[12px]">已打开</span>}
          </button>
        ))}
        {!shown.length && <div className="text-muted-foreground py-4 text-center text-xs">没有匹配的会话</div>}
      </div>
    </>
  )
}

function WebPicker({ winId, onPicked }: { winId: string; onPicked: () => void }) {
  const [v, setV] = useState('')
  const go = () => {
    const u = normUrl(v)
    if (!u) return
    wmStore.setWin(winId, 'web', { url: u })
    onPicked()
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder="5173、localhost:8080 或内部服务地址"
          className="bg-card text-foreground h-8 min-w-0 flex-1 rounded-md px-3 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
        />
        <button onClick={go} className="bg-primary text-primary-foreground rounded-md px-4 text-sm">
          打开
        </button>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        由 kore 服务器代取再嵌入，适合 dev 服务和内部页面；公网大站可能显示不全，可用窗口右上角按钮在新标签页直接打开。
      </p>
    </div>
  )
}

function FilesPicker({
  winId,
  nodes,
  labels,
  onPicked,
}: {
  winId: string
  nodes: Record<string, NodeView>
  labels: any
  onPicked: () => void
}) {
  const ips = useMemo(() => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)), [nodes])
  const [ip, setIp] = useState(() => ips.find((i) => nodes[i]?.self) || ips[0] || '')
  const [roots, setRoots] = useState<Array<{ id: string; label: string; path: string }>>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!ip) return
    let alive = true
    setLoading(true)
    setErr('')
    apiGet<{ ok: boolean; roots: any[]; error?: string }>('/api/kore/fs/roots?node_ip=' + encodeURIComponent(ip))
      .then((d) => {
        if (!alive) return
        if (!d.ok) throw new Error(d.error || '读取失败')
        setRoots(d.roots || [])
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [ip])

  if (!ips.length) return <div className="text-muted-foreground py-6 text-center text-xs">名单还没加载完。</div>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap justify-center gap-1">
        {ips.map((i) => (
          <button
            key={i}
            onClick={() => setIp(i)}
            className={cn(
              'rounded-full px-3 py-1 text-xs',
              ip === i ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {nodeName(i, nodes, labels)}
          </button>
        ))}
      </div>
      <div className="flex max-h-[42vh] flex-col gap-0.5 overflow-auto">
        {loading && <div className="text-muted-foreground py-4 text-center text-xs">读取目录…</div>}
        {err && <div className="text-muted-foreground py-4 text-center text-xs">读不到：{err}</div>}
        {roots.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              wmStore.setWin(winId, 'files', { node_ip: ip, root: r.path, path: r.path, nodeName: nodeName(ip, nodes, labels) })
              onPicked()
            }}
            className="hover:bg-accent flex h-8 items-center gap-2 rounded-md px-3 text-left text-[14px]"
          >
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="text-muted-foreground ml-auto max-w-[55%] truncate font-mono text-[12px] [direction:rtl]">{r.path}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
