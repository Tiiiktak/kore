import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { focusedTerm, tmuxManage } from '@/lib/wm/tmux'
import { wmStore } from '@/lib/wm/store'

// A tmux-prefix-style leader menu. Press the leader (Ctrl+Shift+A) over a focused terminal and
// a small menu pops up listing single-key actions (new / split / rename / kill window, or a
// digit to jump to that window) — the menu IS the documentation. Captured on the document in
// the capture phase and preventDefault'd, so the chord never leaks into the terminal.
//
// Actions target the focused terminal's session + its active tmux window (window-scoped actions
// may omit the index), so they work whether or not a specific window is pinned.
const LEADER = { ctrl: true, shift: true, key: 'a' }

const ACTIONS: Array<{ k: string; label: string; run: () => Promise<boolean> | void }> = [
  { k: 'c', label: '新建窗口', run: () => tmuxManage({ action: 'new-window' }) },
  { k: 's', label: '左右分屏', run: () => tmuxManage({ action: 'split-window', dir: 'h' }) },
  { k: 'v', label: '上下分屏', run: () => tmuxManage({ action: 'split-window', dir: 'v' }) },
  { k: 'r', label: '重命名窗口…', run: () => {} }, // handled inline (opens an input)
  { k: '&', label: '关闭窗口', run: () => tmuxManage({ action: 'kill-window' }) },
  { k: '0–9', label: '切到第 N 个窗口', run: () => {} },
]

export function TmuxLeaderMenu() {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const done = (ok: boolean, msg: string) => {
      setOpen(false)
      setRenaming(false)
      if (!ok) toast.error('操作失败', { description: msg })
    }
    const onKey = (e: KeyboardEvent) => {
      // open on the leader chord (only when a terminal is focused)
      if (!open) {
        if (e.ctrlKey === LEADER.ctrl && e.shiftKey === LEADER.shift && !e.metaKey && !e.altKey && e.key.toLowerCase() === LEADER.key && focusedTerm()) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }
        return
      }
      // menu is open — swallow keys so they don't reach the terminal underneath
      if (renaming) return // the rename input handles its own keys
      e.preventDefault()
      e.stopPropagation()
      const k = e.key
      if (k === 'Escape') return void setOpen(false)
      if (k === 'c') return void Promise.resolve(tmuxManage({ action: 'new-window' })).then((ok) => done(ok, '新建窗口'))
      if (k === 's') return void Promise.resolve(tmuxManage({ action: 'split-window', dir: 'h' })).then((ok) => done(ok, '分屏'))
      if (k === 'v') return void Promise.resolve(tmuxManage({ action: 'split-window', dir: 'v' })).then((ok) => done(ok, '分屏'))
      if (k === '&') return void Promise.resolve(tmuxManage({ action: 'kill-window' })).then((ok) => done(ok, '关闭窗口'))
      if (k === 'r') {
        setRenaming(true)
        setName('')
        setTimeout(() => renameRef.current?.focus(), 0)
        return
      }
      if (/^[0-9]$/.test(k)) {
        const t = focusedTerm()
        if (t) wmStore.setWindow(t.winId, Number(k), undefined)
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey, true) // capture: beat the terminal to the key
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, renaming])

  if (!open) return null
  const t = focusedTerm()
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[18vh]" onPointerDown={() => setOpen(false)}>
      <div
        className="bg-popover ring-foreground/10 w-[280px] rounded-xl p-2 shadow-xl ring-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="text-muted-foreground flex items-center justify-between px-1.5 pb-1.5 text-[11px]">
          <span>tmux 操作 · {t ? t.name : '无焦点终端'}</span>
          <span className="font-mono">⌃⇧A</span>
        </div>
        {renaming ? (
          <input
            ref={renameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新窗口名,回车确认"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && name.trim())
                Promise.resolve(tmuxManage({ action: 'rename-window', title: name.trim() })).then((ok) => {
                  setOpen(false)
                  setRenaming(false)
                  if (!ok) toast.error('重命名失败')
                })
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="bg-card text-foreground h-8 w-full rounded-md px-2.5 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
          />
        ) : (
          <div className="flex flex-col">
            {ACTIONS.map((a) => (
              <div key={a.k} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm">
                <kbd className="bg-muted text-muted-foreground min-w-[28px] rounded px-1.5 py-0.5 text-center font-mono text-[11px]">{a.k}</kbd>
                <span>{a.label}</span>
              </div>
            ))}
            <div className="text-muted-foreground px-1.5 pt-1 text-[11px]">按对应键执行 · Esc 关闭</div>
          </div>
        )}
      </div>
    </div>
  )
}
