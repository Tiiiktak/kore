import { useEffect, useState } from 'react'
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
import { setLabel } from '@/lib/api'
import type { RenameTarget } from '@/lib/ui'

export type { RenameTarget }

// Set a display name (备注) for a session or machine. Empty = clear (revert to the raw name).
export function RenameDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: RenameTarget | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (target) setName(target.current)
  }, [target])

  const save = async () => {
    if (!target) return
    setBusy(true)
    try {
      await setLabel(target.kind, target.key, name.trim())
      onOpenChange(false)
      toast(name.trim() ? '已改备注名' : '已清除备注名')
      onSaved()
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{target?.kind === 'node' ? '机器备注名' : 'session 备注名'}</DialogTitle>
          <DialogDescription>只改显示名（本看板本地），不动真实名字 {target?.placeholder}。</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={target?.placeholder}
          autoFocus
          maxLength={40}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
