import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useRosterCtx } from '@/lib/roster-context'
import { apiGet, kPost } from '@/lib/api'
import { wmStore } from '@/lib/wm/store'
import { listWins } from '@/lib/wm/tree'
import { buildNodes, emptyLabels, nodeName, nodeOrder, sessName, sessKey, type NodeView } from '@/lib/kore'
import type { Labels, Session } from '@/lib/types'
import { normUrl } from '@/lib/wm/web'
import { StatusDot } from '@/components/StatusDot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

type Tab = 'term' | 'web' | 'files'
// Sibling-terminal context: the first non-empty terminal elsewhere in the SAME workspace.
export type Ctx = { node_ip: string; name: string; label: string; node: string } | null

// ---------------------------------------------------------------------------
// Shared hooks / helpers (reused by both the full Launcher and the QuickSwitch popover)
// ---------------------------------------------------------------------------

// The sibling-terminal context of a window + that terminal's CURRENT directory. roster.cwd is
// the create-time value (often empty / stale); the live cwd is each session's
// pane_current_path, which fs_roots exposes as a root labelled "<bare name> · <basename>".
export function useWsCtx(winId: string): { ctx: Ctx; ctxCwd: string } {
  const { roster } = useRosterCtx()
  const prefix = roster?.prefix || 'kore-'
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

  return { ctx, ctxCwd }
}

// Session keys already on screen in the active workspace (shown as "已打开").
export function useOpenKeys(): Set<string> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const ws = wmStore.active()
    const s = new Set<string>()
    if (ws) for (const id of listWins(ws.root)) if (wmStore.termKey(id)) s.add(wmStore.termKey(id))
    return s
  }, [])
}

// Open a session INTO a window — but never duplicate: if the same session is already open
// elsewhere in the workspace, focus that window instead (owner's locked model).
export function pickSession(winId: string, s: Session, labels: Labels, prefix: string, nodes: Record<string, NodeView>) {
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
}

// Arrow-key navigation over a filtered list: ↑/↓ move the highlight, Enter opens it. Reset to
// the top whenever the list length changes (i.e. the filter narrowed/widened the results).
export function useListKeyNav<T>(items: T[], onEnter: (item: T) => void) {
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [items.length])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const it = items[idx]
      if (it !== undefined) onEnter(it)
    }
  }
  return { idx, onKeyDown }
}

// New-session flow: POST start, then wait for the session to appear in the roster and drop it
// into the window. Surfaces background failures (name taken, node down) as real toasts rather
// than a silent "启动中…" that only ends in a timeout.
export function useSessionCreate(opts: {
  winId: string
  prefix: string
  labels: Labels
  nodes: Record<string, NodeView>
  onPicked: () => void
}) {
  const { winId, prefix, labels, nodes, onPicked } = opts
  const { roster, refresh } = useRosterCtx()
  const rows = useMemo(() => roster?.sessions || [], [roster])
  const [pending, setPending] = useState<{ node_ip: string; full: string; bare: string } | null>(null)

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

  // Returns true once the launch request was accepted (so the caller can collapse its form).
  const run = async (node_ip: string, name: string, cwd: string): Promise<boolean> => {
    const nm = name.trim()
    if (!nm || !node_ip) return false
    const full = prefix + nm
    // Pre-check the most common failure — a name already taken on that machine — so it's an
    // instant, clear message rather than a silent wait.
    if (rows.some((s) => s.node_ip === node_ip && s.name === full)) {
      toast.error('这个名字已存在', { description: full })
      return false
    }
    let res: { id?: string }
    try {
      res = await kPost<{ id?: string }>('start', { node_ip, name: nm, cwd: cwd || '~', role: '' })
    } catch (e) {
      toast.error('新建失败', { description: (e as Error).message })
      return false
    }
    setPending({ node_ip, full, bare: nm })
    toast('已新建会话，启动中…', { description: full })
    // `start` is a background job and the roster poll is a cached scan. Force a few re-scans so
    // the session appears (the pending-match effect then fills the window), AND watch the job
    // so a background failure surfaces as a real error instead of a silent timeout.
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
          p && p.node_ip === node_ip && p.bare === nm ? (toast.error('会话没出现', { description: '可刷新，或回总览确认' }), null) : p,
        ),
      14_000,
    )
    return true
  }

  return { pending, run }
}

// ---------------------------------------------------------------------------
// Shared presentational pieces
// ---------------------------------------------------------------------------

// The "联动" badge — which sibling terminal a new pane will continue from.
export function CtxPill({ ctx }: { ctx: NonNullable<Ctx> }) {
  return (
    <div className="bg-muted text-muted-foreground flex max-w-full items-center gap-1.5 self-start rounded-full px-3 py-1 text-xs">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />
      <span className="truncate">
        联动 <span className="text-foreground font-medium">{ctx.label || ctx.name}</span>
        {ctx.node && <span> · {ctx.node}</span>}
      </span>
    </div>
  )
}

// A left-aligned row of machine chips (shared by the terminal-create node picker and files).
export function NodeChips({
  ips,
  ip,
  setIp,
  nodes,
  labels,
}: {
  ips: string[]
  ip: string
  setIp: (ip: string) => void
  nodes: Record<string, NodeView>
  labels: Labels
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {ips.map((i) => (
        <button
          key={i}
          onClick={() => setIp(i)}
          className={cn(
            'rounded-full px-3 py-1 text-xs transition-colors',
            ip === i ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {nodeName(i, nodes, labels)}
        </button>
      ))}
    </div>
  )
}

// One session entry. `active` = keyboard-highlighted; `open` = already on screen. `dense`
// tightens height + font for the compact QuickSwitch popover.
export function SessionRow({
  s,
  labels,
  prefix,
  nodes,
  ctx,
  active,
  open,
  dense = false,
  onClick,
}: {
  s: Session
  labels: Labels
  prefix: string
  nodes: Record<string, NodeView>
  ctx: Ctx
  active: boolean
  open: boolean
  dense?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      data-active={active || undefined}
      className={cn(
        'hover:bg-accent data-active:bg-accent flex items-center gap-2 rounded-md px-2 text-left',
        dense ? 'h-7 text-[13px]' : 'h-8 text-[14px]',
      )}
    >
      <StatusDot state={s.state} />
      <span className="min-w-0 truncate">{sessName(s, labels, prefix)}</span>
      <span className="text-muted-foreground text-xs whitespace-nowrap">{nodeName(s.node_ip, nodes, labels)}</span>
      {ctx && s.node_ip === ctx.node_ip && (
        <span className="text-[11px]" style={{ color: 'var(--brand)' }}>
          同机器
        </span>
      )}
      {open && <span className="text-muted-foreground ml-auto text-[12px]">已打开</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Full-screen launcher (shown in an empty window). Left-aligned card + clear sections.
// ---------------------------------------------------------------------------

export function Launcher({ winId }: { winId: string }) {
  const { roster } = useRosterCtx()
  const [tab, setTab] = useState<Tab>('term')
  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo<Record<string, NodeView>>(() => buildNodes(roster?.nodes || []), [roster])
  const { ctx, ctxCwd } = useWsCtx(winId)

  // Top-anchored (not fixed vertical centering): the card's top — and the tabs you click — stay
  // put when switching tabs changes the content height, so it never feels like it moved. The top
  // spacer wants ~12vh of breathing room but shrinks in a short pane (e.g. an up/down split's
  // bottom half), so the card moves up instead of leaving a big blank above it.
  return (
    <div className="bg-background absolute inset-0 flex flex-col items-center overflow-y-auto px-5 pb-8">
      <div className="min-h-4 shrink grow-0 basis-[12vh]" />
      <div className="bg-card ring-border flex w-[min(460px,100%)] shrink-0 flex-col gap-4 rounded-xl p-5 shadow-sm ring-1">
        <span className="text-sm font-medium">新建窗口</span>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-3">
          <TabsList>
            <TabsTrigger value="term">终端</TabsTrigger>
            <TabsTrigger value="web">浏览器</TabsTrigger>
            <TabsTrigger value="files">文件</TabsTrigger>
          </TabsList>
          <TabsContent value="term" className="flex-none">
            <TermPicker winId={winId} prefix={prefix} labels={labels} nodes={nodes} ctx={ctx} ctxCwd={ctxCwd} onPicked={() => {}} />
          </TabsContent>
          <TabsContent value="web" className="flex-none">
            <WebPicker winId={winId} onPicked={() => {}} />
          </TabsContent>
          <TabsContent value="files" className="flex-none">
            <FilesPicker winId={winId} nodes={nodes} labels={labels} ctx={ctx} ctxCwd={ctxCwd} onPicked={() => {}} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pickers (exported — reused by QuickSwitch)
// ---------------------------------------------------------------------------

export function TermPicker({
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
  labels: Labels
  nodes: Record<string, NodeView>
  ctx: Ctx
  ctxCwd: string
  onPicked: () => void
}) {
  const { roster } = useRosterCtx()
  const [q, setQ] = useState('')
  const rows = useMemo(() => roster?.sessions || [], [roster])
  const openKeys = useOpenKeys()
  const create = useSessionCreate({ winId, prefix, labels, nodes, onPicked })

  const base = q
    ? rows.filter((s) => (sessName(s, labels, prefix) + ' ' + s.name + ' ' + nodeName(s.node_ip, nodes, labels)).toLowerCase().includes(q.toLowerCase()))
    : rows
  // Same-machine sessions first when we have context (stable sort keeps the rest in order).
  const shown = ctx ? [...base].sort((a, b) => Number(b.node_ip === ctx.node_ip) - Number(a.node_ip === ctx.node_ip)) : base

  const pick = (s: Session) => {
    pickSession(winId, s, labels, prefix, nodes)
    onPicked()
  }
  const nav = useListKeyNav(shown, pick)

  return (
    <div className="flex flex-col gap-3">
      {ctx && <CtxPill ctx={ctx} />}
      <CreateSession ctx={ctx} ctxCwd={ctxCwd} nodes={nodes} labels={labels} create={create} />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={nav.onKeyDown}
        placeholder="过滤会话 / 机器"
        aria-label="过滤会话"
        autoFocus
      />
      <ScrollArea className="max-h-[46vh]">
        <div className="flex flex-col gap-0.5 pr-2">
          {shown.map((s, i) => (
            <SessionRow
              key={sessKey(s)}
              s={s}
              labels={labels}
              prefix={prefix}
              nodes={nodes}
              ctx={ctx}
              active={i === nav.idx}
              open={openKeys.has(sessKey(s))}
              onClick={() => pick(s)}
            />
          ))}
          {!shown.length && (
            <div className="text-muted-foreground py-4 text-center text-xs">
              {rows.length ? '没有匹配的会话' : ctx ? '这台机器还没有会话，用上面的「新建会话」建一个。' : '还没有会话，用上面的「新建会话」建一个。'}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// New-session control: a dashed "新建会话" button that expands into a name input. With sibling
// context it targets that machine + cwd; without, it shows a machine picker first (no more
// dead-end "go back to overview").
function CreateSession({
  ctx,
  ctxCwd,
  nodes,
  labels,
  create,
}: {
  ctx: Ctx
  ctxCwd: string
  nodes: Record<string, NodeView>
  labels: Labels
  create: ReturnType<typeof useSessionCreate>
}) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const ips = useMemo(() => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)), [nodes])
  const [ip, setIp] = useState(() => (ctx && nodes[ctx.node_ip] ? ctx.node_ip : ips.find((i) => nodes[i]?.self) || ips[0] || ''))
  const target = ctx ? ctx.node_ip : ip
  const cwd = ctx ? ctxCwd || '~' : '~'

  const submit = async () => {
    const ok = await create.run(target, newName, cwd)
    if (ok) {
      setCreating(false)
      setNewName('')
    }
  }

  if (create.pending) {
    return (
      <div className="text-muted-foreground flex h-9 items-center justify-center gap-2 text-xs">
        <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> 新建的会话启动中…
      </div>
    )
  }
  if (!creating) {
    return (
      <Button variant="outline" size="default" className="w-full justify-start border-dashed" onClick={() => setCreating(true)}>
        <Plus /> 在 {ctx ? ctx.node || '同机器' : '指定机器'} 新建会话
        {ctx && ctxCwd && <span className="text-muted-foreground ml-auto max-w-[45%] truncate font-mono text-[11px]">（{ctxCwd}）</span>}
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {!ctx && ips.length > 0 && <NodeChips ips={ips} ip={ip} setIp={setIp} nodes={nodes} labels={labels} />}
      <div className="flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') setCreating(false)
          }}
          placeholder={`在 ${ctx ? ctx.node || '同机器' : nodeName(target, nodes, labels) || '机器'} 新建会话名`}
        />
        <Button size="default" onClick={submit}>
          新建
        </Button>
      </div>
    </div>
  )
}

export function WebPicker({ winId, onPicked }: { winId: string; onPicked: () => void }) {
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
        <Input
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder="5173、localhost:8080 或内部服务地址"
        />
        <Button size="default" onClick={go}>
          打开
        </Button>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        由 kore 服务器代取再嵌入，适合 dev 服务和内部页面；公网大站可能显示不全，可用窗口右上角按钮在新标签页直接打开。
      </p>
    </div>
  )
}

export function FilesPicker({
  winId,
  nodes,
  labels,
  ctx,
  ctxCwd,
  dense = false,
  onPicked,
}: {
  winId: string
  nodes: Record<string, NodeView>
  labels: Labels
  ctx: Ctx
  ctxCwd: string
  dense?: boolean
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
    <div className="flex flex-col gap-3">
      {/* context-aware shortcut: open the sibling terminal's current directory directly */}
      {ctx && ctxCwd && (
        <Button variant="outline" size="default" className="w-full justify-start border-dashed" onClick={() => openFiles(ctx.node_ip, ctxCwd)}>
          <Plus /> 打开当前终端目录
          <span className="text-muted-foreground ml-auto max-w-[60%] truncate font-mono text-[11px] [direction:rtl]">{ctxCwd}</span>
        </Button>
      )}
      <NodeChips ips={ips} ip={ip} setIp={setIp} nodes={nodes} labels={labels} />
      <ScrollArea className="max-h-[42vh]">
        <div className="flex flex-col gap-0.5 pr-2">
          {loading && <div className="text-muted-foreground py-4 text-center text-xs">读取目录…</div>}
          {err && <div className="text-muted-foreground py-4 text-center text-xs">读不到：{err}</div>}
          {roots.map((r) => (
            <button
              key={r.id}
              onClick={() => openFiles(ip, r.path)}
              className={cn(
                'hover:bg-accent flex items-center gap-2 rounded-md px-2 text-left',
                dense ? 'h-7 text-[13px]' : 'h-8 text-[14px]',
              )}
            >
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="text-muted-foreground ml-auto max-w-[55%] truncate font-mono text-[12px] [direction:rtl]">{r.path}</span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
