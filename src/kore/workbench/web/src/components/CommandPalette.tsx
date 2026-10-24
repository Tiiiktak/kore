import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Columns2,
  Globe,
  LayoutGrid,
  Plus,
  Rows2,
  SplitSquareHorizontal,
  TerminalSquare,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useRosterCtx } from '@/lib/roster-context'
import { buildNodes, emptyLabels, nodeName, sessName } from '@/lib/kore'
import { wmStore } from '@/lib/wm/store'
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

// ⌘K / Ctrl+K palette, built on the plain shadcn Dialog + a filtered list (no cmdk dep).
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const { roster } = useRosterCtx()
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
    const s = wmStore.get()
    const focused = s.workspaces[s.cur]?.focused
    const list: Item[] = [
      { id: 'home', group: '操作', label: '总览', icon: LayoutGrid, keywords: 'home overview zonglan', run: () => wmStore.setView('home') },
      { id: 'newws', group: '操作', label: '新建工作区', icon: Plus, keywords: 'new workspace xinjian gongzuoqu', run: () => wmStore.newBlankWorkspace() },
    ]
    if (focused) {
      list.push(
        { id: 'splitrow', group: '操作', label: '左右分屏（当前窗口）', icon: Columns2, keywords: 'split row zuoyou fenping', run: () => wmStore.split(focused, 'row') },
        { id: 'splitcol', group: '操作', label: '上下分屏（当前窗口）', icon: Rows2, keywords: 'split col shangxia fenping', run: () => wmStore.split(focused, 'col') },
        { id: 'web', group: '当前窗口', label: '改为浏览器窗口', icon: Globe, keywords: 'browser web liulanqi', run: () => wmStore.setWin(focused, 'web', {}) },
        { id: 'reset', group: '当前窗口', label: '清空重选（终端 / 浏览器 / 文件）', icon: TerminalSquare, keywords: 'reset empty qingkong', run: () => wmStore.setWin(focused, 'term', {}) },
      )
    }
    s.workspaces.forEach((ws, i) => {
      const names = wmStore.wsSummary(ws).names.map((n) => n.title).join(' | ') || '新窗口'
      list.push({ id: 'ws' + ws.id, group: '工作区', label: names, icon: SplitSquareHorizontal, keywords: 'workspace ' + names, run: () => wmStore.switchWs(i) })
    })
    for (const sess of roster?.sessions || []) {
      const nm = sessName(sess, labels, prefix)
      const nn = nodeName(sess.node_ip, nodes, labels)
      list.push({
        id: 'sess' + sess.node_ip + '/' + sess.name,
        group: '打开会话',
        label: nm,
        sub: nn,
        icon: TerminalSquare,
        keywords: (nm + ' ' + sess.name + ' ' + nn).toLowerCase(),
        run: () => wmStore.openSession({ node_ip: sess.node_ip, name: sess.name, writable: sess.writable, label: nm, node: nn }),
      })
    }
    return list
  }, [roster, open])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? items.filter((it) => (it.label + ' ' + it.keywords).toLowerCase().includes(t)) : items
  }, [items, q])

  const selClamped = Math.min(sel, Math.max(0, filtered.length - 1))
  const runAt = (i: number) => {
    const it = filtered[i]
    if (!it) return
    setOpen(false)
    it.run()
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
      <DialogContent showCloseButton={false} className="top-[15%] max-w-[560px] translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">打开会话、新建窗口、切换工作区</DialogDescription>
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
          placeholder="输入命令或会话名…"
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
      </DialogContent>
    </Dialog>
  )
}
