import { useEffect, useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// The one confirm pattern for irreversible actions that have an on-screen anchor (kill a
// session / tmux window, restart or upgrade a node, install a version): a small popover that
// spells out the consequence and offers 取消 / 确认 — never a one-click or click-twice trigger.
// (Actions fired from a context menu have no anchor and confirm in a Dialog instead.)
//
// Uncontrolled: the child is the trigger. Controlled (`open` + `onOpenChange`, `anchorOnly`): the
// child is only the anchor — for opening the confirm from a menu item next to it. `hint` gives an
// icon-only trigger its hover tooltip (composed here: a Hint can't sit between trigger and button).
export function ConfirmPopover({
  title,
  desc,
  confirmLabel,
  run,
  destructive = true,
  align = 'end',
  open: openProp,
  onOpenChange,
  anchorOnly = false,
  hint,
  children,
}: {
  title: string
  desc: string
  confirmLabel: string
  run: () => Promise<unknown> | void
  destructive?: boolean
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (v: boolean) => void
  anchorOnly?: boolean
  hint?: string
  children: ReactElement
}) {
  const [own, setOwn] = useState(false)
  const open = openProp ?? own
  const setOpen = onOpenChange ?? setOwn
  const [busy, setBusy] = useState(false)
  // Opened from a menu item, the closing menu's trailing focus/pointer events land "outside" and
  // would dismiss the confirm the instant it appears — ignore outside interaction briefly.
  const openedAt = useRef(0)
  useEffect(() => {
    if (open) openedAt.current = Date.now()
  }, [open])
  const go = async () => {
    setBusy(true)
    try {
      await run()
      setOpen(false)
    } catch (err) {
      toast.error('操作失败', { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {anchorOnly ? (
        <PopoverAnchor asChild>{children}</PopoverAnchor>
      ) : hint ? (
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      )}
      <PopoverContent
        align={align}
        className="w-64"
        onClick={(e) => e.stopPropagation()}
        onInteractOutside={(e) => Date.now() - openedAt.current < 300 && e.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">{title}</div>
          <p className="text-muted-foreground text-xs leading-relaxed">{desc}</p>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant={destructive ? 'destructive' : 'default'} size="sm" className="h-7" onClick={go} disabled={busy} autoFocus>
              {busy ? '执行中…' : confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
