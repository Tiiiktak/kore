import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { createKoreTerminal, type KoreTerminal } from '@/lib/term/terminal'
import { MobileInput } from './MobileInput'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'

// Mounts the imperative terminal engine into a ref'd host. Keyed by winId upstream so the host
// survives re-renders (layout changes only reposition it). `focused` gates keyboard input;
// fit is debounced so split/sash drags don't spam the backend with resize calls. On mobile a
// compose box + key row (MobileInput) is attached, and the key row floats above the soft keyboard.
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
  const kbInset = useKeyboardInset()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const engine = createKoreTerminal(host, { node_ip: nodeIp, name, writable }, setStatus, winId, setCtrlArmed)
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
