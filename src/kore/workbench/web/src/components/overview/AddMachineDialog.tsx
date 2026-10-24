import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiGet } from '@/lib/api'

interface JoinInfo {
  ok: boolean
  server: string
  install: string
  command: string
  enabled: boolean
  clients: Array<{ node_ip: string; hostname: string; online: boolean; last_seen_s: number; sessions: number }>
}

// "Add a machine": read-only instructions. Shows the exact `kore client` line to run on the
// other machine so it registers as a worker, plus the current clients and their health.
export function AddMachineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [info, setInfo] = useState<JoinInfo | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!open) return
    setErr('')
    apiGet<JoinInfo>('/api/join')
      .then(setInfo)
      .catch((e) => setErr((e as Error).message))
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>添加机器</DialogTitle>
          <DialogDescription>在另一台机器上运行下面这行，它就会作为 worker 节点加入（不改任何现有会话）。</DialogDescription>
        </DialogHeader>
        {err && <div className="text-bad text-sm">{err}</div>}
        {info && (
          <div className="flex min-w-0 flex-col gap-3">
            {info.enabled && info.command ? (
              <CopyLine label="在新机器上运行" text={info.command} />
            ) : (
              <div className="text-muted-foreground bg-muted rounded-md px-3 py-2 text-xs">
                服务端未配置 agent token（<span className="font-mono">KORE_AGENT_TOKEN</span>），暂时无法加入新机器。
              </div>
            )}
            <CopyLine label="（没装 kore？先装）" text={info.install} />
            <div>
              <div className="text-muted-foreground mb-1.5 text-xs">已加入的机器</div>
              {info.clients.length === 0 && <div className="text-muted-foreground text-xs">还没有 client 机器加入。</div>}
              <div className="flex flex-col gap-1">
                {info.clients.map((c) => (
                  <div key={c.node_ip} className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: c.online ? 'var(--ok)' : 'var(--muted-foreground)' }} />
                    <span className="shrink-0 font-medium">{c.hostname || c.node_ip}</span>
                    <span className="text-muted-foreground min-w-0 truncate font-mono">{c.node_ip}</span>
                    <span className="text-muted-foreground ml-auto shrink-0 whitespace-nowrap">
                      {c.online ? `${c.sessions} 个会话` : `${c.last_seen_s}s 前离线`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground mb-1.5 text-xs">{label}</div>
      <div className="bg-secondary flex min-w-0 items-center gap-2 rounded-md p-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{text}</code>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              },
              () => {},
            )
          }}
          aria-label="复制"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded"
        >
          {copied ? <Check className="size-4 text-[var(--ok)]" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  )
}
