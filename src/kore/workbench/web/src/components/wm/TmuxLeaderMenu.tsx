import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { focusedTerm, tmuxManage } from '@/lib/wm/tmux'
import { wmStore } from '@/lib/wm/store'
import { setUi, useUi } from '@/lib/ui'
import { cn } from '@/lib/utils'

// A tmux-prefix-style leader menu. Press the leader (Ctrl+Shift+A) over a focused terminal (or
// pick it in ⌘K) and a small menu pops up listing single-key actions (new / split / rename / kill
// window, or a digit to jump to that window) — the menu IS the documentation, and every row is
// also clickable. Captured on the document in the capture phase and preventDefault'd, so the
// chord never leaks into the terminal.
//
// Actions target the focused terminal's session + its active tmux window (window-scoped actions
// may omit the index), so they work whether or not a specific window is pinned. Killing a window
// is irreversible, so `&` asks like tmux does: press y to confirm.
const LEADER = { ctrl: true, shift: true, key: 'a' }

const ACTIONS: Array<{ k: string; label: string; bad?: boolean }> = [
  { k: 'c', label: '新建窗口' },
  { k: 's', label: '左右分屏' },
  { k: 'v', label: '上下分屏' },
  { k: 'r', label: '重命名窗口…' },
  { k: '&', label: '关闭窗口…', bad: true },
  { k: '0–9', label: '切到第 N 个窗口' },
]

export function TmuxLeaderMenu() {
  const { leader: open } = useUi()
  const setOpen = (v: boolean) => setUi({ leader: v })
  const [mode, setMode] = useState<'menu' | 'rename' | 'kill'>('menu')
  const [name, setName] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setMode('menu')
  }, [open])

  const done = (ok: boolean, msg: string) => {
    setOpen(false)
    if (!ok) toast.error('操作失败', { description: msg })
  }
  // One dispatcher for keys and clicks.
  const exec = (k: string) => {
    if (k === 'c') return void Promise.resolve(tmuxManage({ action: 'new-window' })).then((ok) => done(ok, '新建窗口'))
    if (k === 's') return void Promise.resolve(tmuxManage({ action: 'split-window', dir: 'h' })).then((ok) => done(ok, '分屏'))
    if (k === 'v') return void Promise.resolve(tmuxManage({ action: 'split-window', dir: 'v' })).then((ok) => done(ok, '分屏'))
    if (k === '&') return void setMode('kill')
    if (k === 'r') {
      setMode('rename')
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

  useEffect(() => {
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
      if (mode === 'rename') return // the rename input handles its own keys
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return void setOpen(false)
      if (mode === 'kill') {
        if (e.key === 'y') Promise.resolve(tmuxManage({ action: 'kill-window' })).then((ok) => done(ok, '关闭窗口'))
        else setMode('menu')
        return
      }
      exec(e.key)
    }
    document.addEventListener('keydown', onKey, true) // capture: beat the terminal to the key
    return () => document.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode])

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
        {mode === 'rename' ? (
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
                  if (!ok) toast.error('重命名失败')
                })
              if (e.key === 'Escape') setMode('menu')
            }}
            className="bg-card text-foreground h-8 w-full rounded-md px-2.5 text-sm outline-none ring-1 ring-[var(--border)] focus:ring-2"
          />
        ) : mode === 'kill' ? (
          <div className="flex flex-col gap-2 px-1.5 py-1">
            <div className="text-sm">关闭当前 tmux 窗口及其中的所有进程？</div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => Promise.resolve(tmuxManage({ action: 'kill-window' })).then((ok) => done(ok, '关闭窗口'))}
                className="bg-destructive rounded-md px-2 py-1 text-xs font-medium text-white"
              >
                关闭（y）
              </button>
              <button onClick={() => setMode('menu')} className="hover:bg-accent rounded-md px-2 py-1 text-xs">
                取消（其他键）
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {ACTIONS.map((a) => {
              const digits = a.k === '0–9'
              return (
                <button
                  key={a.k}
                  disabled={digits}
                  onClick={() => exec(a.k)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm',
                    !digits && 'hover:bg-accent',
                    a.bad && 'text-destructive',
                  )}
                >
                  <kbd className="bg-muted text-muted-foreground min-w-[28px] rounded px-1.5 py-0.5 text-center font-mono text-[11px]">{a.k}</kbd>
                  <span>{a.label}</span>
                </button>
              )
            })}
            <div className="text-muted-foreground px-1.5 pt-1 text-[11px]">按键或点击执行 · Esc 关闭</div>
          </div>
        )}
      </div>
    </div>
  )
}
