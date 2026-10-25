import { useMemo, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useRosterCtx } from '@/lib/roster-context'
import { wmStore } from '@/lib/wm/store'
import { buildNodes, emptyLabels, nodeName, sessName, sessKey, type NodeView } from '@/lib/kore'
import type { Session } from '@/lib/types'
import { normUrl } from '@/lib/wm/web'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { FilesPicker, SessionRow, pickSession, useListKeyNav, useOpenKeys, useWsCtx } from './Launcher'

// The title-button popover: a slim "switch this window's content" picker. Unlike the full
// Launcher (empty windows), it leads with the sessions already open / on the sibling machine,
// skips the new-session flow, and tucks web + files below a divider.
export function QuickSwitch({ winId, onPicked }: { winId: string; onPicked?: () => void }) {
  const { roster } = useRosterCtx()
  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo<Record<string, NodeView>>(() => buildNodes(roster?.nodes || []), [roster])
  const rows = useMemo(() => roster?.sessions || [], [roster])
  const openKeys = useOpenKeys()
  const { ctx, ctxCwd } = useWsCtx(winId)
  const [q, setQ] = useState('')
  const [url, setUrl] = useState('')
  const [showFiles, setShowFiles] = useState(false)

  const done = () => onPicked?.()

  const base = q
    ? rows.filter((s) => (sessName(s, labels, prefix) + ' ' + s.name + ' ' + nodeName(s.node_ip, nodes, labels)).toLowerCase().includes(q.toLowerCase()))
    : rows
  // Already-open sessions first, then same-machine ones (stable sort keeps the rest in order).
  const shown = [...base].sort(
    (a, b) =>
      Number(openKeys.has(sessKey(b))) - Number(openKeys.has(sessKey(a))) ||
      (ctx ? Number(b.node_ip === ctx.node_ip) - Number(a.node_ip === ctx.node_ip) : 0),
  )

  const pick = (s: Session) => {
    pickSession(winId, s, labels, prefix, nodes)
    done()
  }
  const nav = useListKeyNav(shown, pick)

  const go = () => {
    const u = normUrl(url)
    if (!u) return
    wmStore.setWin(winId, 'web', { url: u })
    done()
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground px-1 text-xs">切换到…</div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={nav.onKeyDown} placeholder="过滤会话 / 机器" aria-label="过滤会话" autoFocus />
      <ScrollArea className="max-h-[42vh]">
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
              dense
              onClick={() => pick(s)}
            />
          ))}
          {!shown.length && (
            <div className="text-muted-foreground py-3 text-center text-xs">{rows.length ? '没有匹配的会话' : '还没有会话'}</div>
          )}
        </div>
      </ScrollArea>

      <Separator />

      <div className="flex gap-2">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="网址…" aria-label="打开网址" />
        <Button variant="outline" size="default" onClick={go}>
          打开
        </Button>
      </div>

      {showFiles ? (
        <FilesPicker winId={winId} nodes={nodes} labels={labels} ctx={ctx} ctxCwd={ctxCwd} dense onPicked={done} />
      ) : (
        <Button variant="ghost" size="default" className="justify-start" onClick={() => setShowFiles(true)}>
          <FolderOpen /> 文件…
        </Button>
      )}
    </div>
  )
}
