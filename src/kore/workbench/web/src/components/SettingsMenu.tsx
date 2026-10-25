import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Download, Monitor, Moon, RefreshCw, Settings, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { applyTheme, getTheme, setTheme, type Theme } from '@/lib/theme'
import { fontGet, fontSet, rendererGet, type Renderer } from '@/lib/term/settings'
import { broadcastTerminalSettings } from '@/lib/term/terminal'
import { kConfigGet, kConfigSet, kLatest, kNode, type LatestResp } from '@/lib/api'
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
          <VersionSection />
          <AdvancedSection />
          <p className="text-muted-foreground border-t pt-2 text-xs leading-relaxed">
            WebGL 在非整数缩放下字缘会发虚；「自动」会在那种情况下用 DOM。按 <kbd className="bg-muted rounded px-1">⌘K</kbd> 打开命令面板。
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// A two-step (arm → confirm) action: the first click arms for `ms`, the second fires `run`.
// Shared by the latest-upgrade and the pinned-install/rollback buttons.
function useArmed(run: () => Promise<void>, ms = 3000) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trigger = async () => {
    if (!armed) {
      setArmed(true)
      if (t.current) clearTimeout(t.current)
      t.current = setTimeout(() => setArmed(false), ms)
      return
    }
    if (t.current) clearTimeout(t.current)
    setArmed(false)
    setBusy(true)
    try {
      await run()
    } finally {
      setBusy(false)
    }
  }
  return { armed, busy, trigger }
}

const SEMVER = /^v?\d+\.\d+\.\d+$/

// Installed build + check-latest / upgrade for THIS board. `current` rides the roster poll
// (self-heals after the restart); the check hits /api/kore/latest (server-cached). Upgrade runs
// `kore upgrade && kore server --restart`; the board briefly drops and reconnects, then the
// version updates itself. Rollback (install a specific tag) lives in 高级 below.
function VersionSection() {
  const { roster } = useRosterCtx()
  const current = roster?.version
  const [latest, setLatest] = useState<LatestResp | null>(null)
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      setLatest(await kLatest(true))
    } catch (e) {
      toast.error('检查更新失败', { description: (e as Error).message })
    } finally {
      setChecking(false)
    }
  }
  const up = useArmed(async () => {
    try {
      await kNode('server', 'upgrade')
      toast('正在升级并重启板子', { description: '完成后会自动重连，版本号随后自动刷新' })
    } catch (e) {
      toast.error('升级失败', { description: (e as Error).message })
    }
  })

  return (
    <div className="flex flex-col gap-2 border-t pt-2.5">
      <Row label="版本">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs tabular-nums">{current || '—'}</span>
          <Button variant="outline" size="sm" className="h-7" onClick={check} disabled={checking}>
            <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
            检查更新
          </Button>
        </div>
      </Row>
      {latest &&
        (latest.ok ? (
          latest.outdated ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs">
                新版本 <span className="font-semibold text-[var(--claude)]">{latest.latest}</span> 可用
              </span>
              <Button variant={up.armed ? 'destructive' : 'default'} size="sm" className="h-7" onClick={up.trigger} disabled={up.busy}>
                {!up.busy && <Download className="size-3.5" />}
                {up.busy ? '升级中…' : up.armed ? '确认升级并重启' : '升级并重启'}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">已是最新（{latest.latest}）</p>
          )
        ) : (
          <p className="text-xs text-[var(--bad)]">检查失败：{latest.error}</p>
        ))}
    </div>
  )
}

// Rarely-touched knobs, folded behind a 高级 disclosure so the menu stays short:
//   • 指定版本回滚 — install any tag (type an older one to roll back).
//   • 升级代理     — the proxy the board uses to reach github.com for 检查更新 / 升级 (intranet
//     nodes usually can't hit GitHub directly). Saved to ~/.kore/config.json (0600, local,
//     uncommitted, never logged; may carry credentials). Empty = direct.
function AdvancedSection() {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [proxy, setProxy] = useState('')
  const [savingProxy, setSavingProxy] = useState(false)

  useEffect(() => {
    if (!open) return
    kConfigGet()
      .then((r) => setProxy(r.config?.upgrade_proxy || ''))
      .catch(() => {})
  }, [open])

  const pinUp = useArmed(async () => {
    const v = pin.trim()
    try {
      await kNode('server', 'upgrade', { version: v })
      toast(`正在安装 ${v} 并重启`, { description: '完成后会自动重连' })
    } catch (e) {
      toast.error('安装失败', { description: (e as Error).message })
    }
  })
  const saveProxy = async () => {
    setSavingProxy(true)
    try {
      await kConfigSet({ upgrade_proxy: proxy.trim() })
      toast('已保存升级代理')
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setSavingProxy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        高级
      </button>
      {open && (
        <div className="flex flex-col gap-3 pl-1">
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px]">指定版本回滚 / 安装</span>
            <div className="flex items-center gap-1.5">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="如 v0.5.2"
                spellCheck={false}
                className="bg-muted focus:ring-ring min-w-0 flex-1 rounded-md px-2 py-1 font-mono text-xs outline-none focus:ring-1"
              />
              <Button
                variant={pinUp.armed ? 'destructive' : 'outline'}
                size="sm"
                className="h-7 shrink-0"
                onClick={pinUp.trigger}
                disabled={pinUp.busy || !SEMVER.test(pin.trim())}
              >
                {pinUp.busy ? '安装中…' : pinUp.armed ? '确认安装' : '安装'}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px]">升级代理（访问 GitHub，留空 = 直连）</span>
            <div className="flex items-center gap-1.5">
              <input
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="http://user:pass@host:port"
                spellCheck={false}
                autoComplete="off"
                className="bg-muted focus:ring-ring min-w-0 flex-1 rounded-md px-2 py-1 font-mono text-xs outline-none focus:ring-1"
              />
              <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={saveProxy} disabled={savingProxy}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
