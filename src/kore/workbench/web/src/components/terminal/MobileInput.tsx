import { useEffect, useRef, useState } from 'react'
import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard, SendHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// The old board's mobile input, ported: a key row (Esc / Tab / ⇧Tab / Ctrl-sticky / ^C / arrows)
// whose keyboard button pops up a native <textarea> compose box (16px to dodge iOS zoom,
// Enter-to-send, IME-aware). Key taps preventDefault so they never steal focus / dismiss the
// soft keyboard. Respects iOS safe areas; when the keyboard is up the bottom inset collapses.
// Glyph keys (shift, arrows) render as SVG icons, never as text arrows.
const KEYS: Array<{ k: string; name: string; label?: string; icon?: LucideIcon; seq?: string; wide?: boolean }> = [
  { k: 'esc', name: 'Esc', label: 'Esc', seq: '\x1b', wide: true },
  { k: 'tab', name: 'Tab', label: 'Tab', seq: '\t', wide: true },
  { k: 'stab', name: 'Shift+Tab', label: 'Tab', icon: ArrowBigUp, seq: '\x1b[Z', wide: true },
  { k: 'ctrl', name: 'Ctrl', label: 'Ctrl', wide: true },
  { k: 'c-c', name: 'Ctrl+C', label: '^C', seq: '\x03' },
  { k: 'left', name: '左', icon: ArrowLeft, seq: '\x1b[D' },
  { k: 'down', name: '下', icon: ArrowDown, seq: '\x1b[B' },
  { k: 'up', name: '上', icon: ArrowUp, seq: '\x1b[A' },
  { k: 'right', name: '右', icon: ArrowRight, seq: '\x1b[C' },
]

export function MobileInput({
  send,
  setCtrl,
  ctrlArmed,
  keyboardUp,
  compose,
  onComposeChange,
}: {
  send: (data: string) => void
  setCtrl: (on: boolean) => void
  ctrlArmed: boolean
  keyboardUp: boolean
  compose: boolean // open state is owned by TerminalView so a tap on the terminal can open it
  onComposeChange: (open: boolean) => void
}) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (compose) taRef.current?.focus()
  }, [compose])

  const grow = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(104, ta.scrollHeight) + 'px'
  }
  const sendLine = () => {
    send(value + '\r') // empty = bare Enter (menu confirms)
    setValue('')
    requestAnimationFrame(() => {
      grow()
      taRef.current?.focus()
    })
  }

  return (
    <div
      className="bg-card flex shrink-0 flex-col"
      style={{ paddingBottom: keyboardUp ? 0 : 'max(8px, env(safe-area-inset-bottom, 0px))' }}
    >
      {compose && (
        <div
          className="flex items-end gap-2 px-[max(10px,env(safe-area-inset-left,0px))] pt-2 pr-[max(10px,env(safe-area-inset-right,0px))]"
        >
          <textarea
            ref={taRef}
            rows={1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              grow()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                sendLine()
              }
            }}
            onBlur={() => setTimeout(() => !taRef.current?.value.trim() && onComposeChange(false), 150)}
            enterKeyHint="send"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="输入或语音… 回车发送"
            className="bg-secondary text-foreground placeholder:text-muted-foreground max-h-[104px] min-w-0 flex-1 resize-none rounded-xl px-3 py-2 text-[16px] leading-snug outline-none focus:ring-2 focus:ring-[var(--border)]"
          />
          <button
            onPointerDown={(e) => e.preventDefault()}
            onClick={sendLine}
            aria-label="发送"
            title="发送（回车）"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--claude)] text-white active:brightness-95"
          >
            <SendHorizontal className="size-[18px]" />
          </button>
        </div>
      )}
      <div
        className="flex items-center gap-1.5 overflow-x-auto px-[max(8px,env(safe-area-inset-left,0px))] pt-2 pr-[max(8px,env(safe-area-inset-right,0px))] [scrollbar-width:none]"
        role="toolbar"
        aria-label="终端额外按键"
      >
        <button
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onComposeChange(!compose)}
          aria-pressed={compose}
          aria-label="输入框"
          title="输入框（输入法 / 语音），点一下出现、再点收起"
          className={cn(
            'flex h-9 shrink-0 items-center justify-center rounded-lg px-3',
            compose ? 'bg-[var(--claude)] text-white' : 'bg-secondary text-foreground',
          )}
        >
          <Keyboard className="size-[18px]" />
        </button>
        {KEYS.map((key) => {
          const isCtrl = key.k === 'ctrl'
          const Icon = key.icon
          return (
            <button
              key={key.k}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                if (isCtrl) setCtrl(!ctrlArmed)
                else if (key.seq) send(key.seq)
              }}
              aria-pressed={isCtrl ? ctrlArmed : undefined}
              aria-label={key.name}
              title={key.name}
              className={cn(
                'flex h-9 shrink-0 items-center justify-center gap-0.5 rounded-lg font-mono text-[13px] font-semibold',
                key.wide ? 'px-3' : 'w-9',
                isCtrl && ctrlArmed ? 'bg-[var(--claude)] text-white' : 'bg-secondary text-foreground active:bg-accent',
              )}
            >
              {Icon && <Icon className={cn('shrink-0', key.k === 'stab' ? 'size-[15px]' : 'size-[18px]')} />}
              {key.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
