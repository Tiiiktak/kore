import { useEffect, useState } from 'react'
import { ChevronRight, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { applyTheme, getTheme, setTheme, type Theme } from '@/lib/theme'
import { fontGet, fontSet, rendererGet, type Renderer } from '@/lib/term/settings'
import { canNotify, requestNotifyPermission, setNotifySettings, useNotifySettings } from '@/lib/notify'
import { setMode, useTabGroups, type GroupMode } from '@/lib/tabgroups'
import { broadcastTerminalSettings } from '@/lib/term/terminal'
import { Hint } from '@/components/Hint'
import { setUi } from '@/lib/ui'
import { kConfigGet, kConfigSet } from '@/lib/api'
import { toast } from 'sonner'
import { useRosterCtx } from '@/lib/roster-context'
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
const GROUP_MODES: { v: GroupMode; label: string }[] = [
  { v: 'none', label: '无' },
  { v: 'machine', label: '按机器' },
  { v: 'custom', label: '自定义' },
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
        // icon-only options get a hover hint; text options already say what they are
        <Hint key={v} label={Icon ? label : ''}>
          <button
            onClick={() => onPick(v)}
            aria-pressed={value === v}
            aria-label={label}
            className={cn(
              'flex items-center gap-1 rounded-sm px-2 py-1 text-xs transition-colors',
              value === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {label && !Icon && label}
          </button>
        </Hint>
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

// iOS-style switch; knob is bg-background so it reads in both themes.
function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        disabled ? 'cursor-not-allowed opacity-40' : '',
        checked ? 'bg-[var(--claude)]' : 'bg-muted',
      )}
    >
      <span
        className={cn('bg-background absolute top-0.5 size-4 rounded-full shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')}
      />
    </button>
  )
}

function EventPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'rounded-sm px-2 py-1 text-xs transition-colors',
        on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

// GPU metrics in the overview's machine strip. A BOARD setting (server config, shared by every
// device), off by default: it runs nvidia-smi on every node each poll, which hangs on a host
// with a broken NVIDIA driver.
function GpuMetricsRow({ open }: { open: boolean }) {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!open) return
    kConfigGet()
      .then((r) => setOn(r.config?.sysinfo_gpu === '1'))
      .catch(() => {})
  }, [open])
  const flip = async (v: boolean) => {
    setOn(v)
    try {
      await kConfigSet({ sysinfo_gpu: v ? '1' : '' })
    } catch (e) {
      setOn(!v)
      toast.error('保存失败', { description: (e as Error).message })
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Row label="GPU 指标">
        <Switch checked={!!on} disabled={on === null} onChange={flip} />
      </Row>
      <p className="text-muted-foreground text-[11px] leading-relaxed">在各机器上运行 nvidia-smi；驱动异常的机器上它会卡住。对所有设备生效。</p>
    </div>
  )
}

// Workspace-tab grouping mode. Custom groups themselves are made/assigned from each tab's
// right-click menu (WorkspaceTabs); this just picks how the strip is bucketed.
function TabGroupRow() {
  const tg = useTabGroups()
  return (
    <Row label="标签分组">
      <Seg value={tg.mode} options={GROUP_MODES} onPick={setMode} />
    </Row>
  )
}

// Notification prefs — browser (Notification API) + sound (WebAudio beep) + which events fire.
// All alerts route through lib/notify; this is just its control surface.
function NotifySection() {
  const s = useNotifySettings()
  const supported = canNotify()

  const toggleBrowser = async (v: boolean) => {
    if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const ok = await requestNotifyPermission()
      if (!ok) {
        setNotifySettings({ browser: false })
        return
      }
    }
    setNotifySettings({ browser: v })
  }

  return (
    <div className="flex flex-col gap-2.5 border-t pt-2.5">
      <Row label="浏览器通知">
        <Switch checked={s.browser && supported} disabled={!supported} onChange={toggleBrowser} />
      </Row>
      {!supported && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          浏览器通知需安全上下文：从 <kbd className="bg-muted rounded px-1">127.0.0.1</kbd>/localhost 或 HTTPS 打开才可用。
        </p>
      )}
      <Row label="声音提示">
        <Switch checked={s.sound} onChange={(v) => setNotifySettings({ sound: v })} />
      </Row>
      <Row label="通知事件">
        <div className="bg-muted flex items-center gap-0.5 rounded-md p-0.5">
          <EventPill on={s.events.waiting} onClick={() => setNotifySettings({ events: { waiting: !s.events.waiting } })}>
            需要你
          </EventPill>
          <EventPill on={s.events.done} onClick={() => setNotifySettings({ events: { done: !s.events.done } })}>
            刚完成
          </EventPill>
        </div>
      </Row>
    </div>
  )
}

// Everyday display + notification prefs only. Version / upgrade / rollback / proxy are ops,
// not preferences — they live in the 版本与升级 dialog (SystemDialog) behind the last row.
export function SettingsMenu() {
  const { roster } = useRosterCtx()
  const [open, setOpen] = useState(false)
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
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) setThemeState(getTheme()) // the ⌘K palette can change it too
      }}
    >
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
          <div className="flex flex-col gap-1">
            <Row label="终端渲染器">
              <Seg value={renderer} options={RENDERERS} onPick={pickRenderer} />
            </Row>
            <p className="text-muted-foreground text-[11px] leading-relaxed">WebGL 在非整数缩放下字缘会发虚；「自动」会在那时改用 DOM。</p>
          </div>
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
          <TabGroupRow />
          <GpuMetricsRow open={open} />
          <NotifySection />
          <div className="border-t pt-1.5">
            <button
              onClick={() => {
                setOpen(false)
                setUi({ system: true })
              }}
              className="hover:bg-accent -mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between rounded-md px-1.5 py-1 text-left"
            >
              <span className="text-sm font-medium">版本与升级</span>
              <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
                {roster?.version || '—'}
                <ChevronRight className="size-3.5" />
              </span>
            </button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            按 <kbd className="bg-muted rounded px-1">⌘K</kbd> 打开命令面板。
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

