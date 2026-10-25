import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useRosterCtx } from '@/lib/roster-context'
import { apiGet, kPost } from '@/lib/api'
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
// Sibling-terminal context: the first non-empty terminal elsewhere in the SAME workspace.
type Ctx = { node_ip: string; name: string; label: string; node: string } | null

// Empty-window picker (also reused inside the title Switch popover). Fills the given window.
// When the workspace already holds a terminal (e.g. you just split one), the pickers lean
// toward that terminal's machine and cwd, so the new pane continues the same context.
export function Launcher({ winId, compact = false, onPicked }: { winId: string; compact?: boolean; onPicked?: () => void }) {
  const { roster } = useRosterCtx()
  const [tab, setTab] = useState<Tab>('term')
  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo<Record<string, NodeView>>(() => buildNodes(roster?.nodes || []), [roster])

  const ctx = useMemo<Ctx>(() => {
    const ws = wmStore.active()
    if (!ws) return null
    const st = wmStore.get()
    for (const id of listWins(ws.root)) {
      if (id === winId) continue
      const w = st.wins[id]
      if (w && w.type === 'term' && w.state.node_ip) {
        return {
          node_ip: w.state.node_ip as string,
          name: w.state.name as string,
          label: (w.state.label as string) || '',
          node: (w.state.node as string) || '',
        }
      }
    }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winId])
  // The sibling terminal's CURRENT directory. roster.cwd is the create-time value (often
  // empty / stale); the live cwd is each session's pane_current_path, which fs_roots exposes
  // as a root labelled "<bare session name> · <basename>" — match on that.
  const [ctxCwd, setCtxCwd] = useState('')
  useEffect(() => {
    if (!ctx) {
      setCtxCwd('')
      return
    }
    let alive = true
    const bare = ctx.name.startsWith(prefix) ? ctx.name.slice(prefix.length) : ctx.name
    apiGet<{ ok: boolean; roots?: Array<{ label: string; path: string }> }>(
      '/api/kore/fs/roots?node_ip=' + encodeURIComponent(ctx.node_ip),
    )
      .then((d) => {
        if (!alive) return
        const hit = d.ok ? (d.roots || []).find((r) => String(r.label || '').split(' · ')[0] === bare) : undefined
        setCtxCwd(hit?.path || '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [ctx, prefix])

  const pick = () => onPicked?.()

  return (
    <div className={cn('flex flex-col items-stretch gap-3', compact ? 'p-0' : 'bg-card absolute inset-0 items-center justify-center p-5')}>
      <div className={cn('flex flex-col gap-3', compact ? 'w-full' : 'w-[min(460px,100%)]')}>
        {ctx && (
          <div className="text-muted-foreground mx-auto flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />
            <span className="truncate">
              联动 <span className="text-foreground font-medium">{ctx.label || ctx.name}</span>
              {ctx.node && <span> · {ctx.node}</span>}
            </span>
          </div>
        )}
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
        {tab === 'term' && <TermPicker winId={winId} prefix={prefix} labels={labels} nodes={nodes} ctx={ctx} ctxCwd={ctxCwd} onPicked={pick} />}
        {tab === 'web' && <WebPicker winId={winId} onPicked={pick} />}
        {tab === 'files' && <FilesPicker winId={winId} nodes={nodes} labels={labels} ctx={ctx} ctxCwd={ctxCwd} onPicked={pick} />}
      </div>
    </div>
  )
}

function TermPicker({
  winId,
  prefix,
  labels,
  nodes,
  ctx,
  ctxCwd,
  onPicked,
}: {
  winId: string
  prefix: string
  labels: any
  nodes: Record<string, NodeView>
  ctx: Ctx
  ctxCwd: string
  onPicked: () => void
}) {
  const { roster, refresh } = useRosterCtx()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [pending, setPending] = useState<{ node_ip: string; full: string; bare: string } | null>(null)
  const rows = useMemo(() => roster?.sessions || [], [roster])
  const openKeys = useMemo(() => {
    const ws = wmStore.active()
    const s = new Set<string>()
    if (ws) for (const id of listWins(ws.root)) if (wmStore.termKey(id)) s.add(wmStore.termKey(id))
    return s
  }, [])

  // A session we just created shows up in the roster a moment later — when it does, drop it
  // into this window automatically (start only types the launch command; roster lags ~2.5s).
  useEffect(() => {
    if (!pending) return
    const hit = rows.find((s) => s.node_ip === pending.node_ip && (s.name === pending.full || s.name === pending.bare))
    if (!hit) return
    wmStore.setWin(winId, 'term', {
      node_ip: hit.node_ip,
      name: hit.name,
      writable: hit.writable,
      label: sessName(hit, labels, prefix),
      node: nodeName(hit.node_ip, nodes, labels),
    })
    setPending(null)
    onPicked()
  }, [rows, pending, winId, labels, prefix, nodes, onPicked])

  const base = q
    ? rows.filter((s) => (sessName(s, labels, prefix) + ' ' + s.name + ' ' + nodeName(s.node_ip, nodes, labels)).toLowerCase().includes(q.toLowerCase()))
    : rows
  // Same-machine sessions first when we have context (stable sort keeps the rest in order).
  const shown = ctx ? [...base].sort((a, b) => Number(b.node_ip === ctx.node_ip) - Number(a.node_ip === ctx.node_ip)) : base

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

  const create = async () => {
    if (!ctx) return
    const nm = newName.trim()
    if (!nm) return
    const full = prefix + nm
    // Pre-check the most common failure — a name already taken on that machine — so it's an
    // instant, clear message rather than a silent wait.
    if (rows.some((s) => s.node_ip === ctx.node_ip && s.name === full)) {
      toast.error('这个名字已存在', { description: full })
      return
    }
    let res: { id?: string }
    try {
      res = await kPost<{ id?: string }>('start', { node_ip: ctx.node_ip, name: nm, cwd: ctxCwd || '~', role: '' })
    } catch (e) {
      toast.error('新建失败', { description: (e as Error).message })
      return
    }
    setPending({ node_ip: ctx.node_ip, full, bare: nm })
    setCreating(false)
    setNewName('')
    toast('已新建会话，启动中…', { description: full })
    // `start` is a background job and the roster poll is a cached 10s scan. Force a few
    // re-scans so the session appears (the pending-match effect then fills the window), AND
    // watch the job so a background failure (name taken, node down, agent killed) surfaces as
    // a real error instead of a silent "启动中…" that only ends in a timeout.
    ;[600, 1800, 3500, 6000, 9000].forEach((ms) => setTimeout(() => refresh(), ms))
    const jid = res?.id
    if (jid) {
      let tries = 0
      const poll = setInterval(async () => {
        tries += 1
        try {
          const j = await apiGet<{ state?: string; ok?: boolean; error?: string }>('/api/kore/job?id=' + encodeURIComponent(jid))
          if (j.state === 'failed' || j.ok === false) {
            clearInterval(poll)
            setPending(null)
            toast.error('新建失败', { description: j.error || '未知原因' })
          } else if (j.state === 'done') {
            clearInterval(poll)
          }
        } catch {
          /* transient poll error — keep trying */
        }
        if (tries >= 10) clearInterval(poll)
      }, 1200)
    }
    setTimeout(
      () =>
        setPending((p) =>
          p && p.node_ip === ctx.node_ip && p.bare === nm ? (toast.error('会话没出现', { description: '可刷新，或回总览确认' }), null) : p,
        ),
      14_000,
    )
  }

  return (
    <>
      {/* context-aware shortcut: make a new session on the sibling terminal's machine + cwd */}
      {ctx &&
        (pending ? (
          <div className="text-muted-foreground flex h-9 items-center justify-center gap-2 text-xs">
            <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> 新建的会话启动中…
          </div>
        ) : creating ? (
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder={`在 ${ctx.node || '同机器'} 新建会话名`}
              className="bg-card text-foreground h-8 min-w-0 flex-1 rounded-md px-3 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
            />
            <button onClick={create} className="bg-primary text-primary-foreground shrink-0 rounded-md px-3 text-sm">
              新建
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="border-border text-foreground hover:bg-accent flex h-9 items-center justify-center gap-1.5 rounded-md border border-dashed text-sm"
          >
            <Plus className="size-4 shrink-0" /> 在 {ctx.node || '同机器'} 新建会话
            {ctxCwd && <span className="text-muted-foreground max-w-[45%] truncate font-mono text-[11px]">（{ctxCwd}）</span>}
          </button>
        ))}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="过滤会话 / 机器"
        aria-label="过滤会话"
        className="bg-card text-foreground h-8 w-full rounded-md px-3 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
      />
      <div className="flex max-h-[46vh] flex-col gap-0.5 overflow-auto">
        {shown.map((s) => (
          <button key={sessKey(s)} onClick={() => open(s)} className="hover:bg-accent flex h-8 items-center gap-2 rounded-md px-3 text-left text-[14px]">
            <StatusDot state={s.state} />
            <span className="min-w-0 truncate">{sessName(s, labels, prefix)}</span>
            <span className="text-muted-foreground text-xs whitespace-nowrap">{nodeName(s.node_ip, nodes, labels)}</span>
            {ctx && s.node_ip === ctx.node_ip && (
              <span className="text-[11px]" style={{ color: 'var(--brand)' }}>
                同机器
              </span>
            )}
            {openKeys.has(sessKey(s)) && <span className="text-muted-foreground ml-auto text-[12px]">已打开</span>}
          </button>
        ))}
        {!shown.length && (
          <div className="text-muted-foreground py-4 text-center text-xs">
            {rows.length ? '没有匹配的会话' : ctx ? '这台机器还没有会话，用上面的「新建会话」建一个。' : '还没有会话。回到总览新建一个。'}
          </div>
        )}
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
  ctx,
  ctxCwd,
  onPicked,
}: {
  winId: string
  nodes: Record<string, NodeView>
  labels: any
  ctx: Ctx
  ctxCwd: string
  onPicked: () => void
}) {
  const ips = useMemo(() => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)), [nodes])
  // Default to the sibling terminal's machine when we have one, else self.
  const [ip, setIp] = useState(() => (ctx && nodes[ctx.node_ip] ? ctx.node_ip : ips.find((i) => nodes[i]?.self) || ips[0] || ''))
  const [roots, setRoots] = useState<Array<{ id: string; label: string; path: string }>>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const openFiles = (nip: string, path: string) => {
    wmStore.setWin(winId, 'files', { node_ip: nip, root: path, path, nodeName: nodeName(nip, nodes, labels) })
    onPicked()
  }

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
      {/* context-aware shortcut: open the sibling terminal's current directory directly */}
      {ctx && ctxCwd && (
        <button
          onClick={() => openFiles(ctx.node_ip, ctxCwd)}
          className="border-border text-foreground hover:bg-accent flex h-9 items-center gap-1.5 rounded-md border border-dashed px-3 text-sm"
        >
          <Plus className="size-4 shrink-0" /> 打开当前终端目录
          <span className="text-muted-foreground ml-auto max-w-[60%] truncate font-mono text-[11px] [direction:rtl]">{ctxCwd}</span>
        </button>
      )}
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
            onClick={() => openFiles(ip, r.path)}
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
