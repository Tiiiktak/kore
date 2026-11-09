import { useEffect, useState } from 'react'
import { ChevronRight, Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmPopover } from '@/components/ConfirmPopover'
import { kConfigGet, kConfigSet, kLatest, kNode, type LatestResp } from '@/lib/api'
import { useRosterCtx } from '@/lib/roster-context'
import { setUi, useUi } from '@/lib/ui'
import { cn } from '@/lib/utils'

// 版本与升级: this board's build, check-latest / upgrade, and the rarely-touched 高级 knobs.
// Opened from the settings popover's last row and from the version label in the nav.
export function SystemDialog() {
  const { system } = useUi()
  return (
    <Dialog open={system} onOpenChange={(v) => setUi({ system: v })}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>版本与升级</DialogTitle>
          <DialogDescription>升级会重启本机板子；tmux / Claude session 不受影响。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <VersionSection />
          <AdvancedSection />
        </div>
      </DialogContent>
    </Dialog>
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
  const upgrade = async () => {
    await kNode('server', 'upgrade')
    toast('正在升级并重启板子', { description: '完成后会自动重连，版本号随后自动刷新' })
  }

  return (
    <div className="flex flex-col gap-2">
      <Row label="当前版本">
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
              <ConfirmPopover
                title={`升级到 ${latest.latest} 并重启？`}
                desc="拉取新版本并重启本机板子。看板会短暂断开并自动重连；tmux / Claude session 不受影响。"
                confirmLabel="升级并重启"
                destructive={false}
                run={upgrade}
              >
                <Button size="sm" className="h-7">
                  <Download className="size-3.5" />
                  升级并重启
                </Button>
              </ConfirmPopover>
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

  const install = async () => {
    const v = pin.trim()
    await kNode('server', 'upgrade', { version: v })
    toast(`正在安装 ${v} 并重启`, { description: '完成后会自动重连' })
  }
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
              <ConfirmPopover
                title={`安装 ${pin.trim()} 并重启？`}
                desc="安装这个版本（可以是更旧的，即回滚）并重启本机板子。看板会短暂断开并自动重连。"
                confirmLabel="安装并重启"
                run={install}
              >
                <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={!SEMVER.test(pin.trim())}>
                  安装
                </Button>
              </ConfirmPopover>
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
