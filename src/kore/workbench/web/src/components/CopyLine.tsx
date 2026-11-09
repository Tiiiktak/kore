import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'

// Text to paste elsewhere (a command, a link): shown IN FULL (wrapped, never truncated — a cut-off
// token is useless), click the text to select it all, or use the copy button.
export function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      toast.error('复制失败', { description: '浏览器不允许写剪贴板，请选中命令后手动复制' })
    }
  }
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground mb-1.5 text-xs">{label}</div>
      <div className="bg-secondary flex min-w-0 items-start gap-2 rounded-md p-1 pl-3">
        <code className="min-w-0 flex-1 py-1.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">
          {text}
        </code>
        <button
          onClick={copy}
          aria-label="复制"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded"
        >
          {copied ? <Check className="size-4 text-[var(--ok)]" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  )
}
