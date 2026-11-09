import { useEffect, useMemo, useState } from 'react'
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
import { useSessionCreate } from '@/hooks/useSessionCreate'
import { DirPicker } from '@/components/DirPicker'
import { buildNodes, emptyLabels, nodeName, nodeOrder } from '@/lib/kore'
import type { Roster } from '@/lib/types'

// Create a new kore session from the overview, via the shared create flow (useSessionCreate).
// It doesn't open the session — the card appears in the overview once the roster catches up.
export function NewSessionDialog({
  open,
  onOpenChange,
  roster,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  roster: Roster | null
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
  const create = useSessionCreate()

  // Reset only when the dialog OPENS. `nodes`/`ips` are rebuilt on every roster poll (~6s),
  // so keying the reset on them wiped whatever the user had picked or typed mid-dialog.
  useEffect(() => {
    if (!open) return
    setNode('')
    setName('')
    setCwd('~')
    setRole('')
  }, [open])
  // Default machine: once the list is there and nothing is picked yet (also covers a
  // roster that was still loading when the dialog opened).
  useEffect(() => {
    if (open && !node && ips.length) setNode(ips.find((i) => nodes[i]?.self) || ips[0])
  }, [open, node, ips, nodes])

  const submit = async () => {
    setBusy(true)
    const ok = await create.run(node, name, cwd, role)
    setBusy(false)
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>新建 session</DialogTitle>
          <DialogDescription>在选定机器上建一个 tmux session 并输入启动命令（不自动回车）。</DialogDescription>
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
            <DirPicker nodeIp={node} value={cwd} onChange={setCwd} disabled={!node} />
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
