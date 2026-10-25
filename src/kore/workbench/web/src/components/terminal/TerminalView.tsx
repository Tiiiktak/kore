import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { createKoreTerminal, type KoreTerminal } from '@/lib/term/terminal'
import { MobileInput } from './MobileInput'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'

// Mounts the imperative terminal engine into a ref'd host. Keyed by winId upstream so the host
// survives re-renders (layout changes only reposition it). `focused` gates keyboard input;
// fit is debounced so split/sash drags don't spam the backend with resize calls. On mobile a
// compose box + key row (MobileInput) is attached, and the key row floats above the soft keyboard.
// The kore brand mark as vector sub-pixels (same shape as the favicon / top-left logo).
// Each [x, y] is a 1×2 cell; the loader animates them with a diagonal phase offset (x+y) so a
// wave of light sweeps across the mark and loops seamlessly.
const LOADER_MARK: ReadonlyArray<readonly [number, number]> = [
  [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0],
  [2, 2], [3, 2], [6, 2], [7, 2],
  [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4],
  [2, 6], [3, 6],
]

export function TerminalView({
  nodeIp,
  name,
  writable,
  winId,
  focused = true,
  mobile = false,
  reloadKey = 0,
}: {
  nodeIp: string
  name: string
  writable: boolean
  winId: string
  focused?: boolean
  mobile?: boolean
  reloadKey?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<KoreTerminal | null>(null)
  const [status, setStatus] = useState('')
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [compose, setCompose] = useState(false)
  const [ready, setReady] = useState(false)
  const kbInset = useKeyboardInset()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setReady(false)
    const engine = createKoreTerminal(host, { node_ip: nodeIp, name, writable }, setStatus, winId, setCtrlArmed, () => setReady(true))
    engineRef.current = engine
    // On mobile, keep the window logically focused (so compose/key-row sends pass the input
    // gate) but don't DOM-focus xterm (that would aim the soft keyboard at the wrong surface).
    if (focused) engine.focus(!mobile)
    else engine.blur()
    let t: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t)
      t = setTimeout(() => engine.fit(), 120)
    })
    ro.observe(host)
    return () => {
      if (t) clearTimeout(t)
      ro.disconnect()
      engine.dispose()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIp, name, writable, winId, reloadKey])

  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    if (focused) e.focus(!mobile)
    else e.blur()
  }, [focused, mobile])

  return (
    <div className="flex size-full flex-col overflow-hidden bg-[#212121]">
      <div className="relative min-h-0 flex-1">
        {/* Mobile: a tap (click fires only on a tap, not a scroll-drag) opens the compose box,
            so the user can start typing / dictating without first hitting the keyboard key. */}
        <div
          ref={hostRef}
          onClick={mobile && writable ? () => setCompose(true) : undefined}
          className="tw-host absolute inset-0 overflow-hidden [&.scroll]:overflow-auto [&_.xterm]:px-2.5 [&_.xterm]:pt-1.5"
        />
        {/* Connecting overlay — our brand mark with a diagonal "pixel wave", delayed 0.3s so a
            fast local connect never flashes it; torn down the moment the first real frame paints
            (engine onReady). Replaces the old board's #c-pane-loading. */}
        {!ready && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[1] flex flex-col items-center justify-center gap-4 [animation:termLoadIn_.2s_ease_.3s_both]"
            style={{ transform: 'translateY(-5%)' }}
          >
            <svg
              viewBox="0 0 8 8"
              className="size-11 text-[var(--claude)] select-none"
              fill="currentColor"
              shapeRendering="crispEdges"
              style={{ filter: 'drop-shadow(0 0 7px color-mix(in oklch, var(--claude) 60%, transparent))' }}
            >
              {LOADER_MARK.map(([x, y], i) => (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width="1"
                  height="2"
                  style={{ animation: 'termPixelWave 1.5s ease-in-out infinite', animationDelay: `${((x + y) * 0.06).toFixed(2)}s` }}
                />
              ))}
            </svg>
            <div className="text-muted-foreground text-[10px] font-medium tracking-[0.3em] uppercase">Connecting…</div>
          </div>
        )}
        {status && (
          <div className="pointer-events-none absolute bottom-1 left-2.5 z-[2] font-mono text-[10px] text-[#8a8a8a]">{status}</div>
        )}
      </div>
      {mobile && writable && (
        <MobileInput
          send={(d) => engineRef.current?.send(d)}
          setCtrl={(on) => engineRef.current?.setCtrl(on)}
          ctrlArmed={ctrlArmed}
          keyboardUp={kbInset > 0}
          compose={compose}
          onComposeChange={setCompose}
        />
      )}
    </div>
  )
}
