import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, kPost } from '@/lib/api'
import { useRosterCtx } from '@/lib/roster-context'
import type { Session } from '@/lib/types'

// The one new-session flow, shared by the overview's 新建 dialog and an empty window's launcher:
// POST start, then watch for the session to appear in the roster. `start` only TYPES the launch
// command into the new tmux session (no Enter), so the toast says so. Background failures (name
// taken, node down) surface as real toasts rather than a silent wait that ends in a timeout.
//
// `onAppeared` runs once the session shows up — the launcher fills its own window with it; the
// overview passes nothing (creating there doesn't open a new workspace).
export function useSessionCreate(onAppeared?: (s: Session) => void) {
  const { roster, refresh } = useRosterCtx()
  const prefix = roster?.prefix || 'kore-'
  const rows = useMemo(() => roster?.sessions || [], [roster])
  const [pending, setPending] = useState<{ node_ip: string; full: string; bare: string } | null>(null)
  const appeared = useRef(onAppeared)
  appeared.current = onAppeared

  // start lands in the roster a moment later (cached scan, ~2.5s) — match it, then hand it over.
  useEffect(() => {
    if (!pending) return
    const hit = rows.find((s) => s.node_ip === pending.node_ip && (s.name === pending.full || s.name === pending.bare))
    if (!hit) return
    setPending(null)
    appeared.current?.(hit)
  }, [rows, pending])

  // Returns true once the launch request was accepted (so the caller can close its form).
  const run = async (node_ip: string, name: string, cwd: string, role = ''): Promise<boolean> => {
    const nm = name.trim()
    if (!nm || !node_ip) return false
    const full = prefix + nm
    // Pre-check the most common failure — a name already taken on that machine.
    if (rows.some((s) => s.node_ip === node_ip && s.name === full)) {
      toast.error('这个 session 名已存在', { description: full })
      return false
    }
    let res: { id?: string }
    try {
      res = await kPost<{ id?: string }>('start', { node_ip, name: nm, cwd: cwd.trim() || '~', role: role.trim() })
    } catch (e) {
      toast.error('新建失败', { description: (e as Error).message })
      return false
    }
    setPending({ node_ip, full, bare: nm })
    toast('已新建 session', { description: `${full} · 启动命令已输入，在终端里按 Enter 启动` })
    // Force a few re-scans so the session appears promptly, AND watch the job so a background
    // failure surfaces as an error instead of a silent timeout.
    ;[600, 1800, 3500, 6000, 9000].forEach((ms) => setTimeout(() => refresh(), ms))
    const jid = res?.id
    if (jid) {
      let tries = 0
      const poll = setInterval(async () => {
        tries += 1
        try {
          const j = await apiGet<{ state?: string; ok?: boolean; error?: string }>('/api/kore/job?id=' + encodeURIComponent(jid))
          if (j.state === 'failed' || j.ok === false) {
            clearInterval(poll)
            setPending(null)
            toast.error('新建失败', { description: j.error || '未知原因' })
          } else if (j.state === 'done') {
            clearInterval(poll)
          }
        } catch {
          /* transient poll error — keep trying */
        }
        if (tries >= 10) clearInterval(poll)
      }, 1200)
    }
    setTimeout(
      () =>
        setPending((p) =>
          p && p.node_ip === node_ip && p.bare === nm ? (toast.error('session 没出现', { description: '可刷新，或回总览确认' }), null) : p,
        ),
      14_000,
    )
    return true
  }

  return { pending, run }
}
