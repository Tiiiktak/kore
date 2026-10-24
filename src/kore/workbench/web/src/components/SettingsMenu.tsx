import { useEffect, useState } from 'react'
import { Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { applyTheme, getTheme, setTheme, type Theme } from '@/lib/theme'
import { fontGet, fontSet, rendererGet, type Renderer } from '@/lib/term/settings'
import { broadcastTerminalSettings } from '@/lib/term/terminal'
import { cn } from '@/lib/utils'

const THEMES: { v: Theme; label: string; icon: typeof Sun }[] = [
  { v: 'light', label: '浅色', icon: Sun },
  { v: 'dark', label: '深色', icon: Moon },
  { v: 'auto', label: '跟随系统', icon: Monitor },
]
const RENDERERS: { v: Renderer; label: string }[] = [
  { v: 'auto', label: '自动' },
  { v: 'dom', label: 'DOM' },
  { v: 'webgl', label: 'WebGL' },
]

function Seg<T extends string>({
  value,
  options,
  onPick,
}: {
  value: T
  options: { v: T; label?: string; icon?: typeof Sun }[]
  onPick: (v: T) => void
}) {
  return (
    <div className="bg-muted flex items-center gap-0.5 rounded-md p-0.5">
      {options.map(({ v, label, icon: Icon }) => (
        <button
          key={v}
          onClick={() => onPick(v)}
          aria-pressed={value === v}
          title={label}
          className={cn(
            'flex items-center gap-1 rounded-sm px-2 py-1 text-xs transition-colors',
            value === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {Icon && <Icon className="size-3.5" />}
          {label && !Icon && label}
        </button>
      ))}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  )
}

export function SettingsMenu() {
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [renderer, setRendererState] = useState<Renderer>(rendererGet)
  const [font, setFontState] = useState<number>(fontGet)

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const pickTheme = (v: Theme) => {
    setTheme(v)
    setThemeState(v)
  }
  const pickRenderer = (v: Renderer) => {
    try {
      localStorage.setItem('kore.pane.renderer', v)
    } catch {
      /* ignore */
    }
    setRendererState(v)
    broadcastTerminalSettings()
  }
  const bumpFont = (d: number) => {
    const v = fontSet(font + d)
    setFontState(v)
    broadcastTerminalSettings()
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="设置">
          <Settings />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-3.5">
          <Row label="外观">
            <Seg value={theme} options={THEMES} onPick={pickTheme} />
          </Row>
          <Row label="终端渲染器">
            <Seg value={renderer} options={RENDERERS} onPick={pickRenderer} />
          </Row>
          <Row label="终端字号">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" onClick={() => bumpFont(-1)} aria-label="字号减小">
                −
              </Button>
              <span className="w-10 text-center text-xs tabular-nums">{font}px</span>
              <Button variant="outline" size="icon" className="size-7" onClick={() => bumpFont(1)} aria-label="字号增大">
                +
              </Button>
            </div>
          </Row>
          <p className="text-muted-foreground border-t pt-2 text-xs leading-relaxed">
            WebGL 在非整数缩放下字缘会发虚；「自动」会在那种情况下用 DOM。按 <kbd className="bg-muted rounded px-1">⌘K</kbd> 打开命令面板。
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
