import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { SendHorizontal } from 'lucide-react'
import { BrandMark } from '@/components/BrandMark'
import { StatusDot } from '@/components/StatusDot'
import { CopyLine } from '@/components/CopyLine'
import { STATE_LABEL } from '@/lib/kore'

interface Info {
  ok: boolean
  session: string
  node: string
  scope: 'read' | 'chat'
  label: string
  expires_at: number
  can_chat: boolean
  error?: string
}

const POLL_MS = 1500

// What a share link (/s/<token>) opens: one session's live screen, read-only, and — for a
// "chat" link — a box to message the agent in it. Everything goes through /api/share/<token>,
// which the board checks against the link; the page holds no board token.
export function SharePage({ token }: { token: string }) {
  const base = `/api/share/${token}`
  const [info, setInfo] = useState<Info | null>(null)
  const [dead, setDead] = useState('')
  const [state, setState] = useState('')
  const [msg, setMsg] = useState('')
  const [pending, setPending] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    fetch(base, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: Info) => (d.ok ? setInfo(d) : setDead(d.error || '链接无效')))
      .catch(() => setDead('连不上看板'))
  }, [base])

  // the screen: a read-only xterm repainted from each capture
  useEffect(() => {
    if (!info || !hostRef.current) return
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12,
      fontFamily: 'Monaco, Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
      scrollback: 0,
      theme: { background: getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim() || '#212121' },
    })
    term.open(hostRef.current)
    termRef.current = term
    let alive = true
    let last = ''
    const tick = async () => {
      try {
        const r = await fetch(`${base}/read`, { cache: 'no-store' })
        const d = await r.json()
        if (!alive) return
        if (r.status === 404) {
          setDead(d.error || '链接已失效')
          return
        }
        if (!d.ok) return
        setState(d.state || '')
        if (d.cols && d.rows && (term.cols !== d.cols || term.rows !== d.rows)) term.resize(d.cols, d.rows)
        const out = String(d.output || '')
        if (out !== last) {
          last = out
          term.reset()
          term.write(out.replace(/\r?\n/g, '\r\n'))
        }
      } catch {
        /* transient — next tick */
      }
    }
    tick()
    const iv = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      clearInterval(iv)
      term.dispose()
      termRef.current = null
    }
  }, [info, base])

  const send = async () => {
    const text = msg.trim()
    if (!text || pending) return
    setPending('发送中…')
    try {
      const r = await fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, wait: false }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.refused || d.error || 'HTTP ' + r.status)
      setMsg('')
      setPending('agent 处理中…')
      // the reply shows up on the screen above; poll the job only to know when it's over
      for (let i = 0; i < 400; i++) {
        await new Promise((res) => setTimeout(res, 1500))
        const j = await (await fetch(`${base}/job?id=${encodeURIComponent(d.job_id)}`, { cache: 'no-store' })).json()
        if (j.done) {
          setPending(j.agent_state === 'waiting' ? 'agent 停在一个需要 owner 确认的提示上' : '')
          return
        }
      }
      setPending('')
    } catch (e) {
      setPending('')
      alert('发送失败：' + (e as Error).message)
    }
  }

  if (dead)
    return (
      <div className="bg-background text-muted-foreground flex h-dvh flex-col items-center justify-center gap-3 text-sm">
        <BrandMark className="size-8 text-[var(--claude)]" />
        {dead}
      </div>
    )
  if (!info) return <div className="bg-background h-dvh" />

  const api = `${location.origin}${base}`
  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <BrandMark className="size-[18px] shrink-0 text-[var(--claude)]" />
        <span className="font-semibold">{info.session}</span>
        <span className="text-muted-foreground text-xs">{info.node}</span>
        {state && (
          <span className="flex items-center gap-1 text-xs">
            <StatusDot state={state} />
            {STATE_LABEL[state] || state}
          </span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">
          {info.can_chat ? '可对话' : '只读'} · 有效至 {new Date(info.expires_at * 1000).toLocaleString()}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--term-bg)] p-2">
        <div ref={hostRef} />
      </div>
      {info.can_chat && (
        <div className="flex shrink-0 flex-col gap-2 border-t p-2">
          <div className="flex items-center gap-2">
            <input
              value={msg}
              onChange={(e) => setMsg(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()}
              disabled={!!pending}
              placeholder="给这个 session 里的 agent 发一条消息，回车发送"
              className="bg-secondary min-w-0 flex-1 rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
            <button
              onClick={send}
              disabled={!!pending || !msg.trim()}
              aria-label="发送"
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--claude)] text-white disabled:opacity-50"
            >
              <SendHorizontal className="size-4" />
            </button>
          </div>
          {pending && <div className="text-muted-foreground text-xs">{pending}</div>}
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">给 agent 调用的接口</summary>
            <div className="mt-2 flex flex-col gap-2">
              <CopyLine label="发消息并等回复（返回 reply / screen / agent_state）" text={`curl -s -X POST ${api}/send -H 'Content-Type: application/json' -d '{"message":"你好"}'`} />
              <CopyLine label="读当前画面" text={`curl -s '${api}/read?ansi=0'`} />
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
