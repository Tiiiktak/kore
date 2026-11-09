import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Hint } from '@/components/Hint'
import { CopyLine } from '@/components/CopyLine'
import { kShareCreate, kShareRevoke, kSharesList, type Share, type ShareScope } from '@/lib/api'
import { cn } from '@/lib/utils'

const TTLS: Array<{ s: number; label: string }> = [
  { s: 3600, label: '1 小时' },
  { s: 86400, label: '24 小时' },
  { s: 7 * 86400, label: '7 天' },
]

function left(expiresAt: number): string {
  const s = Math.max(0, expiresAt - Date.now() / 1000)
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟`
  if (s < 86400) return `${Math.round(s / 3600)} 小时`
  return `${Math.round(s / 86400)} 天`
}

function Seg<T extends string | number>({ value, options, onPick }: { value: T; options: Array<{ v: T; label: string }>; onPick: (v: T) => void }) {
  return (
    <div className="bg-muted flex items-center gap-0.5 rounded-md p-0.5">
      {options.map((o) => (
        <button
          key={String(o.v)}
          onClick={() => onPick(o.v)}
          aria-pressed={value === o.v}
          className={cn(
            'rounded-sm px-2 py-1 text-xs transition-colors',
            value === o.v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Terminal-window header control: make a share link for THIS session (read-only, or chat:
// others / other agents can message the agent in it), see the live ones, revoke them.
// A new link's token is shown once — the board stores only its hash.
export function ShareMenu({ nodeIp, name }: { nodeIp: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<ShareScope>('read')
  const [ttl, setTtl] = useState(86400)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Share | null>(null)
  const [list, setList] = useState<Share[]>([])

  const reload = () =>
    kSharesList(nodeIp, name)
      .then((d) => setList(d.shares || []))
      .catch(() => {})
  useEffect(() => {
    if (!open) return
    setMade(null)
    setScope('read')
    setTtl(86400)
    setLabel('')
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const create = async () => {
    setBusy(true)
    try {
      setMade(await kShareCreate({ node_ip: nodeIp, name, scope, ttl_s: ttl, label }))
      reload()
    } catch (e) {
      toast.error('生成失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (id: string) => {
    try {
      await kShareRevoke(id)
      if (made?.id === id) setMade(null)
      reload()
      toast('已撤销分享链接')
    } catch (e) {
      toast.error('撤销失败', { description: (e as Error).message })
    }
  }

  const link = made?.token ? `${location.origin}/s/${made.token}` : ''
  const api = made?.token ? `${location.origin}/api/share/${made.token}` : ''

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label="分享">
        <PopoverTrigger asChild>
          <button
            aria-label="分享这个 session"
            className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground aria-expanded:bg-foreground/10 flex size-6 items-center justify-center rounded-lg transition-colors"
          >
            <Share2 className="size-4" />
          </button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-[400px]">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">分享这个 session</div>

          {made ? (
            <div className="flex flex-col gap-2.5">
              <CopyLine label="分享链接（只显示这一次）" text={link} />
              {made.scope === 'chat' && (
                <CopyLine
                  label="给 agent 用：发一条消息，返回它的回复"
                  text={`curl -s -X POST ${api}/send -H 'Content-Type: application/json' -d '{"message":"你好"}'`}
                />
              )}
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {made.scope === 'chat' ? '对话' : '只读'} · {left(made.expires_at)}后失效。agent 用同一个 token：GET /api/share/&lt;token&gt; 看这个链接能做什么，GET …/read 读当前画面。
              </p>
              <Button variant="outline" size="sm" className="self-start" onClick={() => setMade(null)}>
                再生成一个
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">权限</span>
                <Seg
                  value={scope}
                  options={[
                    { v: 'read' as ShareScope, label: '只读' },
                    { v: 'chat' as ShareScope, label: '对话' },
                  ]}
                  onPick={setScope}
                />
              </div>
              {scope === 'chat' && (
                <p className="bg-warn-bg text-warn rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed">
                  对方可以给这个 session 里的 Claude 发指令。它能执行命令的话，对方就能间接在这台机器上操作。只分享给信任的人或 agent。
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">有效期</span>
                <Seg value={ttl} options={TTLS.map((t) => ({ v: t.s, label: t.label }))} onPick={setTtl} />
              </div>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注：给谁 / 做什么（可空）" maxLength={60} />
              <Button size="sm" onClick={create} disabled={busy}>
                {busy ? '生成中…' : '生成链接'}
              </Button>
            </div>
          )}

          {list.length > 0 && (
            <div className="flex flex-col gap-1 border-t pt-2.5">
              <div className="text-muted-foreground text-[11px]">生效中的分享</div>
              {list.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-xs">
                  <span className={cn('rounded px-1.5 py-0.5 text-[10px]', s.scope === 'chat' ? 'bg-warn-bg text-warn' : 'bg-muted text-muted-foreground')}>
                    {s.scope === 'chat' ? '对话' : '只读'}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.label || <span className="text-muted-foreground">（无备注）</span>}</span>
                  <span className="text-muted-foreground shrink-0">{left(s.expires_at)}</span>
                  <button onClick={() => revoke(s.id)} className="text-muted-foreground hover:text-bad shrink-0 rounded px-1.5 py-0.5 hover:bg-[var(--bad-bg)]">
                    撤销
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
