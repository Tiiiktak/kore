import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { kPost } from '@/lib/api'
import { buildNodes, emptyLabels, nodeName, nodeOrder } from '@/lib/kore'
import type { Roster } from '@/lib/types'

// Create a new kore session: POST /api/kore/start {node_ip, name, cwd, role}. Per the backend,
// this only TYPES the launch command into the new tmux session (no auto-Enter); the roster
// refreshes a moment later so the new session appears.
export function NewSessionDialog({
  open,
  onOpenChange,
  roster,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  roster: Roster | null
  onCreated: () => void
}) {
  const prefix = roster?.prefix || 'kore-'
  const labels = roster?.labels || emptyLabels
  const nodes = useMemo(() => buildNodes(roster?.nodes || []), [roster])
  const ips = useMemo(() => Object.keys(nodes).sort((a, b) => (nodeOrder(a, nodes) < nodeOrder(b, nodes) ? -1 : 1)), [nodes])

  const [node, setNode] = useState('')
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('~')
  const [role, setRole] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setNode(ips.find((i) => nodes[i]?.self) || ips[0] || '')
      setName('')
      setCwd('~')
      setRole('')
    }
  }, [open, ips, nodes])

  const submit = async () => {
    const n = name.trim()
    if (!n || !node) return
    setBusy(true)
    try {
      await kPost('start', { node_ip: node, name: n, cwd: cwd.trim() || '~', role: role.trim() })
      onOpenChange(false)
      toast('已新建会话', { description: `${prefix}${n} · 启动命令已输入，在终端里按 Enter 启动` })
      setTimeout(onCreated, 2500)
    } catch (e) {
      toast.error('新建失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>新建 session</DialogTitle>
          <DialogDescription>在选定机器上建一个 tmux 会话并输入启动命令（不自动回车）。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <Field label="机器">
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
          </Field>
          <Field label={`名字（自动加 ${prefix} 前缀）`}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="worker1"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </Field>
          <Field label="工作目录">
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </Field>
          <Field label="角色说明（可空，仅备注）">
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="做什么用的" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !node}>
            {busy ? '新建中…' : '新建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  )
}
