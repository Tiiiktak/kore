import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Columns2, LayoutPanelLeft, RotateCw, Rows2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TerminalView } from '@/components/terminal/TerminalView'
import { BrowserView } from './BrowserView'
import { FilesView } from './FilesView'
import { Launcher } from './Launcher'
import { QuickSwitch } from './QuickSwitch'
import { WindowSwitcher } from './WindowSwitcher'
import { ShareMenu } from './ShareMenu'
import { PaneGrid } from './PaneGrid'
import { TmuxStatusBar } from './TmuxStatusBar'
import { Hint } from '@/components/Hint'
import { wmStore, winSub, winTitle } from '@/lib/wm/store'
import { WM_MIN_H, WM_MIN_W, type Rect } from '@/lib/wm/tree'
import { cn } from '@/lib/utils'

export function WmWindow({ rect, active, mobile = false }: { rect: Rect; active: boolean; mobile?: boolean }) {
  const win = wmStore.get().wins[rect.win]
  const [reloadKey, setReloadKey] = useState(0)
  const [switchOpen, setSwitchOpen] = useState(false)
  if (!win) return null

  const isTerm = win.type === 'term'
  const isEmpty = isTerm && !win.state.node_ip
  const canRow = mobile || rect.w >= 2 * WM_MIN_W + 6
  const canCol = mobile || rect.h >= 2 * WM_MIN_H + 6

  // tmux-style status bar (session name + window tabs + clock). Rendered INSIDE the terminal
  // subtree — above the mobile key row, not below it — so the key row stays pinned to the
  // bottom edge / soft keyboard. Terminals only.
  const statusBar =
    isTerm && !isEmpty ? (
      <TmuxStatusBar winId={rect.win} nodeIp={win.state.node_ip} name={win.state.name} label={winTitle(win)} window={win.state.window} />
    ) : null

  return (
    <div
      className="absolute flex flex-col overflow-hidden"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDownCapture={() => wmStore.focus(rect.win)}
    >
      {/* header */}
      <div className="bg-secondary flex h-8 shrink-0 items-center gap-0.5 pr-1 pl-1">
        <Popover open={switchOpen} onOpenChange={setSwitchOpen}>
          <PopoverTrigger asChild>
            <button
              className="hover:bg-foreground/10 aria-expanded:bg-foreground/10 mr-auto flex h-6 min-w-0 items-center gap-1 rounded-lg pr-1.5 pl-2.5 text-left transition-colors"
              title="切换这个窗口的内容"
            >
              <span className="min-w-0 truncate text-[14px] font-medium">
                {winTitle(win)}
                {winSub(win) && <span className="text-muted-foreground ml-1.5 text-[12px] font-normal">{winSub(win)}</span>}
              </span>
              <ChevronDown className={cn('text-muted-foreground size-3 shrink-0 transition-opacity', active || switchOpen ? 'opacity-100' : 'opacity-0')} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[340px]">
            <QuickSwitch winId={rect.win} onPicked={() => setSwitchOpen(false)} />
          </PopoverContent>
        </Popover>

        {isTerm && !isEmpty && (
          <WindowSwitcher nodeIp={win.state.node_ip} name={win.state.name} winId={rect.win} current={win.state.window} currentPane={win.state.pane} />
        )}
        {isTerm && !isEmpty && <ShareMenu nodeIp={win.state.node_ip} name={win.state.name} />}
        {isTerm && !isEmpty && (
          <Hint label="重连">
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground flex size-6 items-center justify-center rounded-lg transition-colors"
              aria-label="重连终端"
            >
              <RotateCw className="size-4" />
            </button>
          </Hint>
        )}
        <SplitMenu winId={rect.win} canRow={canRow} canCol={canCol} />
        <button
          onClick={() => wmStore.close(rect.win)}
          className="text-muted-foreground hover:bg-[var(--bad-bg)] hover:text-[var(--bad)] flex size-6 items-center justify-center rounded-lg transition-colors"
          aria-label="关闭窗口"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* body */}
      <div className="relative min-h-0 flex-1">
        {isEmpty ? (
          <Launcher winId={rect.win} />
        ) : isTerm && win.state.window != null && win.state.pane == null ? (
          // A window is selected without pinning one pane → mirror the whole window (all panes
          // laid out by tmux geometry). reloadKey remounts via key.
          <PaneGrid
            key={reloadKey}
            winId={rect.win}
            nodeIp={win.state.node_ip}
            name={win.state.name}
            window={win.state.window}
            writable={win.state.writable}
            focused={active}
            mobile={mobile}
            statusBar={statusBar}
          />
        ) : isTerm ? (
          <TerminalView
            nodeIp={win.state.node_ip}
            name={win.state.name}
            writable={win.state.writable}
            winId={rect.win}
            window={win.state.window}
            pane={win.state.pane}
            focused={active}
            mobile={mobile}
            reloadKey={reloadKey}
            statusBar={statusBar}
          />
        ) : win.type === 'web' ? (
          <BrowserView winId={rect.win} url={win.state.url} />
        ) : (
          <FilesView winId={rect.win} nodeIp={win.state.node_ip} root={win.state.root} path={win.state.path} nodeName={win.state.nodeName} mobile={mobile} />
        )}
      </div>
    </div>
  )
}

// Side-by-side ("并排") a new dashboard window next to this one — a web-layout split, distinct from
// a tmux pane split (分屏). Opens on hover (mouse) AND on click / Enter (keyboard, touch); closes on
// pick, outside press, Esc or pointer leave. The wrapper's `pt-1` bridges the gap so hover holds.
function SplitMenu({ winId, canRow, canCol }: { winId: string; canRow: boolean; canCol: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const leaveT = useRef<ReturnType<typeof setTimeout> | null>(null)
  // hover already opened it → the click that follows must not toggle it shut
  const byHover = useRef(false)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (dir: 'row' | 'col') => {
    setOpen(false)
    wmStore.split(winId, dir)
  }
  const item = 'hover:bg-accent focus-visible:bg-accent flex items-center gap-1.5 rounded-md px-2 py-1 text-sm whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-50'

  return (
    <div
      ref={ref}
      className="relative"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return
        if (leaveT.current) clearTimeout(leaveT.current)
        if (!open) byHover.current = true
        setOpen(true)
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return
        leaveT.current = setTimeout(() => {
          byHover.current = false
          setOpen(false)
        }, 120)
      }}
    >
      {/* no hover hint: hovering already opens the self-labelled menu */}
      <button
        onClick={() => {
          const keep = byHover.current
          byHover.current = false
          setOpen((v) => keep || !v)
        }}
        aria-label="并排窗口"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'text-muted-foreground hover:bg-foreground/10 hover:text-foreground flex size-6 items-center justify-center rounded-lg transition-colors',
          open && 'bg-foreground/10 text-foreground',
        )}
      >
        <LayoutPanelLeft className="size-4" />
      </button>
      <div
        role="menu"
        className={cn(
          'absolute top-full right-0 z-20 pt-1 transition-[opacity,transform] duration-150',
          open ? 'visible translate-y-0 opacity-100' : 'invisible -translate-y-1 opacity-0',
        )}
      >
        <div className="bg-popover ring-foreground/10 flex flex-col gap-0.5 rounded-lg p-1 shadow-md ring-1">
          <button role="menuitem" disabled={!canRow} onClick={() => pick('row')} className={item}>
            <Columns2 className="size-4" /> 左右并排
          </button>
          <button role="menuitem" disabled={!canCol} onClick={() => pick('col')} className={item}>
            <Rows2 className="size-4" /> 上下并排
          </button>
        </div>
      </div>
    </div>
  )
}
