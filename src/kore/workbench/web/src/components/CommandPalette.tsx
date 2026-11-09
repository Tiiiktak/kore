import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BellRing,
  CircleCheck,
  Columns2,
  Globe,
  Import,
  Keyboard,
  LayoutGrid,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Rows2,
  SplitSquareHorizontal,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Sun,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRosterCtx } from '@/lib/roster-context'
import { STATE_LABEL, buildNodes, emptyLabels, nodeName, nodeOrder, sessKey, sessName } from '@/lib/kore'
import { kPost } from '@/lib/api'
import { effectiveState, markActed } from '@/lib/seen'
import { setTheme } from '@/lib/theme'
import { setUi } from '@/lib/ui'
import { wmStore } from '@/lib/wm/store'
import { focusedTerm, tmuxManage } from '@/lib/wm/tmux'
import { cn } from '@/lib/utils'

interface Item {
  id: string
  group: string
  label: string
  sub?: string
  icon: typeof Plus
  keywords: string
  run: () => void
}

// An irreversible palette action asks first, inside the palette itself (Enter confirms, Esc backs out).
interface Confirm {
  title: string
  desc: string
  label: string
  run: () => Promise<unknown>
}

// ⌘K / Ctrl+K palette, built on the plain shadcn Dialog + a filtered list (no cmdk dep).
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const { roster, fetchedAt, refresh } = useRosterCtx()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setConfirm(null)
    }
  }, [open])
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })

  const items = useMemo<Item[]>(() => {
    const prefix = roster?.prefix || 'kore-'
    const labels = roster?.labels || emptyLabels
    const nodes = buildNodes(roster?.nodes || [])
    const sessions = roster?.sessions || []
    const s = wmStore.get()
    const stage = s.view === 'stage'
    const focused = s.workspaces[s.cur]?.focused
    const visible = wmStore.visibleSessionKeys()
    const open = (sess: (typeof sessions)[number]) =>
      wmStore.openSession({
        node_ip: sess.node_ip,
        name: sess.name,
        writable: sess.writable,
        label: sessName(sess, labels, prefix),
        node: nodeName(sess.node_ip, nodes, labels),
      })

    // Cycle through the sessions in a state, starting after the one in focus — the core loop
    // ("who needs me next?") as a single command.
    const jumpNext = (want: 'waiting' | 'done') => {
      const list = sessions
        .filter((x) => effectiveState(x, visible, fetchedAt) === want)
        .sort((a, b) => (nodeOrder(a.node_ip, nodes) + a.name < nodeOrder(b.node_ip, nodes) + b.name ? -1 : 1))
      const ft = focusedTerm()
      const i = ft && stage ? list.findIndex((x) => sessKey(x) === ft.node_ip + '/' + ft.name) : -1
      const next = list[(i + 1) % list.length]
      if (want === 'waiting') {
        markActed(sessKey(next))
        refresh()
      }
      open(next)
    }
    const nWaiting = sessions.filter((x) => effectiveState(x, visible, fetchedAt) === 'waiting').length
    const nDone = sessions.filter((x) => effectiveState(x, visible, fetchedAt) === 'done').length

    const list: Item[] = []
    if (nWaiting)
      list.push({ id: 'nextwait', group: '跳转', label: `下一个${STATE_LABEL.waiting}的 session`, sub: `${nWaiting} 个`, icon: BellRing, keywords: 'next waiting needs you xuyao', run: () => jumpNext('waiting') })
    if (nDone)
      list.push({ id: 'nextdone', group: '跳转', label: `下一个${STATE_LABEL.done}的 session`, sub: `${nDone} 个`, icon: CircleCheck, keywords: 'next done finished wancheng', run: () => jumpNext('done') })
    list.push(
      { id: 'home', group: '操作', label: '总览', icon: LayoutGrid, keywords: 'home overview zonglan', run: () => wmStore.setView('home') },
      { id: 'newsess', group: '操作', label: '新建 session…', icon: Plus, keywords: 'new session xinjian', run: () => setUi({ newSession: true }) },
      { id: 'adopt', group: '操作', label: '接管已有 tmux session…', icon: Import, keywords: 'adopt existing tmux jieguan', run: () => setUi({ adopt: true }) },
      { id: 'newws', group: '操作', label: '新建工作区', icon: Plus, keywords: 'new workspace xinjian gongzuoqu', run: () => wmStore.newBlankWorkspace() },
    )

    // the session in the focused window
    const ft = stage ? focusedTerm() : null
    const cur = ft && sessions.find((x) => x.node_ip === ft.node_ip && x.name === ft.name)
    if (cur) {
      const nm = sessName(cur, labels, prefix)
      list.push(
        {
          id: 'rename',
          group: '当前 session',
          label: `改备注名：${nm}`,
          icon: Pencil,
          keywords: 'rename label beizhu gaiming',
          run: () =>
            setUi({ rename: { kind: 'session', key: sessKey(cur), current: labels.sessions[sessKey(cur)]?.name || '', placeholder: cur.name } }),
        },
        {
          id: 'kill',
          group: '当前 session',
          label: `结束 session：${nm}…`,
          icon: Trash2,
          keywords: 'kill stop end session jieshu',
          run: () =>
            setConfirm({
              title: `结束 ${nm}？`,
              desc: 'kill 整个 tmux session（含其中所有窗口和进程），不可撤销。',
              label: '结束 session',
              run: async () => {
                await kPost('stop', { node_ip: cur.node_ip, name: cur.name })
                toast('已结束 session', { description: nm })
                setTimeout(refresh, 1200)
              },
            }),
        },
      )
    }
    if (focused && stage) {
      list.push(
        { id: 'splitrow', group: '当前窗口', label: '左右并排一个新窗口', icon: Columns2, keywords: 'split row side by side zuoyou bingpai fenping', run: () => wmStore.split(focused, 'row') },
        { id: 'splitcol', group: '当前窗口', label: '上下并排一个新窗口', icon: Rows2, keywords: 'split col stack shangxia bingpai fenping', run: () => wmStore.split(focused, 'col') },
        { id: 'web', group: '当前窗口', label: '改为浏览器窗口', icon: Globe, keywords: 'browser web liulanqi', run: () => wmStore.setWin(focused, 'web', {}) },
        { id: 'reset', group: '当前窗口', label: '清空重选（终端 / 浏览器 / 文件）', icon: TerminalSquare, keywords: 'reset empty qingkong', run: () => wmStore.setWin(focused, 'term', {}) },
      )
    }
    // tmux window/pane management — only when the focused window is a live terminal (the same
    // actions as the ⌃⇧A leader menu, shown here with their shortcuts).
    if (ft) {
      list.push(
        { id: 'tmleader', group: 'tmux', label: 'tmux 操作菜单', sub: '⌃⇧A', icon: Keyboard, keywords: 'tmux leader menu caidan', run: () => setUi({ leader: true }) },
        { id: 'tmnew', group: 'tmux', label: '新建 tmux 窗口', sub: '⌃⇧A c', icon: Plus, keywords: 'tmux new window xinjian chuangkou', run: () => void tmuxManage({ action: 'new-window' }) },
        { id: 'tmsplith', group: 'tmux', label: 'tmux 左右分屏', sub: '⌃⇧A s', icon: SquareSplitHorizontal, keywords: 'tmux split pane horizontal zuoyou fenping', run: () => void tmuxManage({ action: 'split-window', dir: 'h' }) },
        { id: 'tmsplitv', group: 'tmux', label: 'tmux 上下分屏', sub: '⌃⇧A v', icon: SquareSplitVertical, keywords: 'tmux split pane vertical shangxia fenping', run: () => void tmuxManage({ action: 'split-window', dir: 'v' }) },
        {
          id: 'tmkill',
          group: 'tmux',
          label: '关闭 tmux 窗口…',
          sub: '⌃⇧A &',
          icon: X,
          keywords: 'tmux kill window guanbi chuangkou',
          run: () =>
            setConfirm({
              title: '关闭当前 tmux 窗口？',
              desc: '关闭这个 tmux 窗口及其中的所有分屏和进程，不可撤销。',
              label: '关闭窗口',
              run: async () => {
                if (!(await tmuxManage({ action: 'kill-window' }))) throw new Error('关闭窗口失败')
              },
            }),
        },
      )
    }
    s.workspaces.forEach((ws, i) => {
      const names = wmStore.wsSummary(ws).names.map((n) => n.title).join(' | ') || '新窗口'
      list.push({ id: 'ws' + ws.id, group: '工作区', label: names, icon: SplitSquareHorizontal, keywords: 'workspace ' + names, run: () => wmStore.switchWs(i) })
    })
    for (const sess of sessions) {
      const nm = sessName(sess, labels, prefix)
      const nn = nodeName(sess.node_ip, nodes, labels)
      list.push({
        id: 'sess' + sess.node_ip + '/' + sess.name,
        group: '打开 session',
        label: nm,
        sub: nn,
        icon: TerminalSquare,
        keywords: (nm + ' ' + sess.name + ' ' + nn).toLowerCase(),
        run: () => open(sess),
      })
    }
    list.push(
      { id: 'thlight', group: '外观', label: '浅色主题', icon: Sun, keywords: 'theme light qianse zhuti', run: () => setTheme('light') },
      { id: 'thdark', group: '外观', label: '深色主题', icon: Moon, keywords: 'theme dark shense zhuti', run: () => setTheme('dark') },
      { id: 'thauto', group: '外观', label: '主题跟随系统', icon: Monitor, keywords: 'theme auto system gensui zhuti', run: () => setTheme('auto') },
    )
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, open, fetchedAt])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? items.filter((it) => (it.label + ' ' + it.keywords).toLowerCase().includes(t)) : items
  }, [items, q])

  const selClamped = Math.min(sel, Math.max(0, filtered.length - 1))
  const runAt = (i: number) => {
    const it = filtered[i]
    if (!it) return
    // confirm-type items keep the palette open and swap to the confirm view
    if (it.id === 'kill' || it.id === 'tmkill') return it.run()
    setOpen(false)
    it.run()
  }
  const doConfirm = async () => {
    if (!confirm || busy) return
    setBusy(true)
    try {
      await confirm.run()
      setOpen(false)
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  // group in render order while keeping a flat index for keyboard nav
  const groups: Array<{ name: string; items: Array<{ it: Item; idx: number }> }> = []
  filtered.forEach((it, idx) => {
    let g = groups.find((x) => x.name === it.group)
    if (!g) {
      g = { name: it.group, items: [] }
      groups.push(g)
    }
    g.items.push({ it, idx })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[15%] max-w-[560px] translate-y-0 gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(e) => {
          if (confirm) {
            e.preventDefault()
            setConfirm(null)
          }
        }}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">打开 session、新建窗口、切换工作区</DialogDescription>
        {confirm ? (
          <div
            className="flex flex-col gap-3 p-4"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                doConfirm()
              }
            }}
          >
            <div className="text-sm font-medium">{confirm.title}</div>
            <p className="text-muted-foreground text-xs leading-relaxed">{confirm.desc}</p>
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={busy}>
                取消（Esc）
              </Button>
              <Button variant="destructive" size="sm" onClick={doConfirm} disabled={busy} autoFocus>
                {busy ? '执行中…' : `${confirm.label}（Enter）`}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setSel(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSel((s) => (s + 1) % Math.max(1, filtered.length))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSel((s) => (s - 1 + filtered.length) % Math.max(1, filtered.length))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  runAt(selClamped)
                }
              }}
              placeholder="输入命令或 session 名…"
              className="placeholder:text-muted-foreground h-12 w-full border-b bg-transparent px-4 text-sm outline-none"
              aria-label="命令"
            />
            <div ref={listRef} className="max-h-[52vh] overflow-auto p-1.5">
              {filtered.length === 0 && <div className="text-muted-foreground p-6 text-center text-sm">没有匹配项</div>}
              {groups.map((g) => (
                <div key={g.name}>
                  <div className="text-muted-foreground px-2 pt-2 pb-1 text-[12px] font-medium">{g.name}</div>
                  {g.items.map(({ it, idx }) => (
                    <button
                      key={it.id}
                      onMouseMove={() => setSel(idx)}
                      data-sel={idx === selClamped ? '1' : undefined}
                      onClick={() => runAt(idx)}
                      className={cn(
                        'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
                        idx === selClamped ? 'bg-accent text-accent-foreground' : 'text-foreground',
                      )}
                    >
                      <it.icon className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 truncate">{it.label}</span>
                      {it.sub && <span className="text-muted-foreground ml-auto shrink-0 text-xs">{it.sub}</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
