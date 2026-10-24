import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiGet, kPost } from '@/lib/api'
import { buildNodes, emptyLabels, nodeName, nodeOrder } from '@/lib/kore'
import type { Roster } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Unmanaged {
  name: string
  cwd?: string
  windows?: number
  attached?: boolean
  adoptable?: boolean
  why?: string
}

// Adopt an existing (unprefixed) tmux session on a machine — rename it into the kore prefix.
// Nothing inside the session is touched. GET /api/kore/unmanaged → list, POST adopt per pick.
export function AdoptDialog({
  open,
  onOpenChange,
  roster,
  onAdopted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  roster: Roster | null
  onAdopted: () => void
}) {
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo(() => buildNodes(roster?.nodes || []), [roster])
  const ips = useMemo(() => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)), [nodes])
  const [node, setNode] = useState('')
  const [list, setList] = useState<Unmanaged[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [busyName, setBusyName] = useState('')

  useEffect(() => {
    if (open) setNode(ips.find((i) => nodes[i]?.self) || ips[0] || '')
  }, [open, ips, nodes])

  useEffect(() => {
    if (!open || !node) return
    let alive = true
    setLoading(true)
    setErr('')
    setList([])
    apiGet<{ ok: boolean; sessions: Unmanaged[]; error?: string }>('/api/kore/unmanaged?node_ip=' + encodeURIComponent(node))
      .then((d) => {
        if (!alive) return
        if (!d.ok) throw new Error(d.error || '读取失败')
        setList(d.sessions || [])
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, node])

  const adopt = async (name: string) => {
    setBusyName(name)
    try {
      await kPost('adopt', { node_ip: node, name })
      toast('已接管', { description: `${name} → kore-${name}` })
      setList((l) => l.filter((x) => x.name !== name))
      setTimeout(onAdopted, 1500)
    } catch (e) {
      toast.error('接管失败', { description: (e as Error).message })
    } finally {
      setBusyName('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>接管已有 session</DialogTitle>
          <DialogDescription>把机器上没带 kore- 前缀的 tmux 会话纳入管理（改名加前缀，内容不动）。</DialogDescription>
        </DialogHeader>
        <Select value={node} onValueChange={setNode}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择机器" />
          </SelectTrigger>
          <SelectContent>
            {ips.map((ip) => (
              <SelectItem key={ip} value={ip}>
                {nodeName(ip, nodes, labels)} · {ip}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex max-h-[42vh] flex-col gap-1 overflow-auto">
          {loading && <div className="text-muted-foreground py-6 text-center text-sm">读取中…</div>}
          {err && <div className="text-muted-foreground py-6 text-center text-sm">{err}</div>}
          {!loading && !err && list.length === 0 && (
            <div className="text-muted-foreground py-6 text-center text-sm">这台机器上没有未纳管的 tmux 会话</div>
          )}
          {list.map((u) => (
            <div key={u.name} className="hover:bg-accent flex items-center gap-2 rounded-md px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{u.name}</div>
                <div className="text-muted-foreground truncate text-[11px]">
                  {[u.windows ? `${u.windows} 窗口` : '', u.attached ? '已连接' : '', u.cwd].filter(Boolean).join(' · ')}
                  {u.adoptable === false && u.why ? ` · ${u.why}` : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busyName || u.adoptable === false}
                title={u.adoptable === false ? u.why : undefined}
                onClick={() => adopt(u.name)}
                className={cn(busyName === u.name && 'opacity-60')}
              >
                {busyName === u.name ? '接管中…' : '接管'}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
