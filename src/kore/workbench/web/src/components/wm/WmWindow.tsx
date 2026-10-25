import { useState } from 'react'
import { ChevronDown, Columns2, RotateCw, Rows2, SquareSplitHorizontal, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TerminalView } from '@/components/terminal/TerminalView'
import { BrowserView } from './BrowserView'
import { FilesView } from './FilesView'
import { Launcher } from './Launcher'
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

  return (
    <div
      className="absolute flex flex-col overflow-hidden rounded-lg"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDownCapture={() => wmStore.focus(rect.win)}
    >
      {/* header */}
      <div className="bg-secondary flex h-8 shrink-0 items-center gap-0.5 pr-1 pl-1.5">
        <Popover open={switchOpen} onOpenChange={setSwitchOpen}>
          <PopoverTrigger asChild>
            <button
              className="hover:bg-accent mr-auto flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left"
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
            <Launcher winId={rect.win} compact onPicked={() => setSwitchOpen(false)} />
          </PopoverContent>
        </Popover>

        {isTerm && !isEmpty && (
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 items-center justify-center rounded-md"
            aria-label="重连终端"
            title="重连（卡住 / 无法输入时点）"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {/* split: hover the button to float out the two directions — no click needed. The
            wrapper's `pt-1` bridges the gap to the button so the hover never drops. */}
        <div className="group/split relative">
          <button
            className="text-muted-foreground group-hover/split:bg-accent group-hover/split:text-foreground flex size-6 items-center justify-center rounded-md"
            aria-label="分屏"
            title="分屏"
          >
            <SquareSplitHorizontal className="size-4" />
          </button>
          <div className="invisible absolute top-full right-0 z-20 -translate-y-1 pt-1 opacity-0 transition-[opacity,transform] duration-150 group-hover/split:visible group-hover/split:translate-y-0 group-hover/split:opacity-100">
            <div className="bg-popover ring-foreground/10 flex flex-col gap-0.5 rounded-lg p-1 shadow-md ring-1">
              <button
                disabled={!canRow}
                onClick={() => wmStore.split(rect.win, 'row')}
                className="hover:bg-accent flex items-center gap-1.5 rounded-md px-2 py-1 text-sm whitespace-nowrap disabled:pointer-events-none disabled:opacity-50"
              >
                <Columns2 className="size-4" /> 左右分屏
              </button>
              <button
                disabled={!canCol}
                onClick={() => wmStore.split(rect.win, 'col')}
                className="hover:bg-accent flex items-center gap-1.5 rounded-md px-2 py-1 text-sm whitespace-nowrap disabled:pointer-events-none disabled:opacity-50"
              >
                <Rows2 className="size-4" /> 上下分屏
              </button>
            </div>
          </div>
        </div>
        <button
          onClick={() => wmStore.close(rect.win)}
          className="text-muted-foreground hover:bg-[var(--bad-bg,var(--accent))] hover:text-[var(--bad)] flex size-6 items-center justify-center rounded-md"
          aria-label="关闭窗口"
          title="关闭窗口"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* body */}
      <div className="relative min-h-0 flex-1">
        {isEmpty ? (
          <Launcher winId={rect.win} />
        ) : isTerm ? (
          <TerminalView
            nodeIp={win.state.node_ip}
            name={win.state.name}
            writable={win.state.writable}
            winId={rect.win}
            focused={active}
            mobile={mobile}
            reloadKey={reloadKey}
          />
        ) : win.type === 'web' ? (
          <BrowserView winId={rect.win} url={win.state.url} />
        ) : (
          <FilesView winId={rect.win} nodeIp={win.state.node_ip} root={win.state.root} path={win.state.path} nodeName={win.state.nodeName} mobile={mobile} />
        )}
      </div>

      {/* focus frame — a uniform inset ring overlay (never one-sided), drawn above content */}
      <div
        className="pointer-events-none absolute inset-0 z-[6] rounded-lg transition-shadow"
        style={{ boxShadow: `inset 0 0 0 1px ${active ? 'var(--brand)' : 'var(--border)'}` }}
      />
    </div>
  )
}
