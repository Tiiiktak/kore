import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Folder, Home } from 'lucide-react'
import { kFsList, kFsRoots, type FsEntry, type FsRoot } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// A click-through directory picker: open the popover and step into subdirectories from the
// node's browsable roots ($HOME + each session's live cwd), with the breadcrumb to go back up
// and a manual entry box at the bottom as a fallback. Read-only — it travels the fs READ path,
// so the same node-side policy that scopes roots also bounds where it can go. The chosen value
// is a real absolute path (unambiguous for `start`); a user who wants `~` types it below.
export function DirPicker({
  nodeIp,
  value,
  onChange,
  disabled,
}: {
  nodeIp: string
  value: string
  onChange: (p: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  // browsePath '' = the roots view; otherwise an absolute path we're listing.
  const [browsePath, setBrowsePath] = useState('')
  const [roots, setRoots] = useState<FsRoot[]>([])
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [manual, setManual] = useState(value)

  // On open (and when the node changes): seed from an absolute value, else land on roots.
  useEffect(() => {
    if (!open) return
    setManual(value)
    setBrowsePath(value.startsWith('/') ? value : '')
  }, [open, value, nodeIp])

  // Reset when the target node changes so stale roots/entries never show.
  useEffect(() => {
    setBrowsePath('')
    setEntries([])
    setRoots([])
    setErr('')
  }, [nodeIp])

  // Roots view: fetch the node's browsable roots.
  useEffect(() => {
    if (!open || browsePath !== '' || !nodeIp) return
    let alive = true
    setLoading(true)
    setErr('')
    kFsRoots(nodeIp)
      .then((d) => {
        if (!alive) return
        if (!d.ok) throw new Error(d.error || '读取失败')
        setRoots(d.roots || [])
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, browsePath, nodeIp])

  // Directory view: list the current path, keeping only sub-directories to step into.
  useEffect(() => {
    if (!open || browsePath === '' || !nodeIp) return
    let alive = true
    setLoading(true)
    setErr('')
    kFsList(nodeIp, browsePath)
      .then((d) => {
        if (!alive) return
        if (!d.ok) throw new Error(d.error || '无法进入')
        setEntries((d.entries || []).filter((e) => e.kind === 'dir'))
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, browsePath, nodeIp])

  // Breadcrumb segments of the current path (each links back to that level).
  const crumbs = useMemo(() => {
    if (!browsePath) return []
    const parts = browsePath.split('/').filter(Boolean)
    const out: Array<{ name: string; path: string }> = []
    let acc = ''
    for (const p of parts) {
      acc += '/' + p
      out.push({ name: p, path: acc })
    }
    return out
  }, [browsePath])

  const commit = (p: string) => {
    const v = p.trim()
    if (!v) return
    onChange(v)
    setManual(v)
  }
  // Manual entry: an absolute path navigates there and loads its contents (stay open to keep
  // browsing / drilling down); `~` or a relative path is taken as the final value (fallback —
  // the node lists real paths, not `~`), closing on Enter.
  const loadManual = (close: boolean) => {
    const v = manual.trim()
    if (!v) return
    if (v.startsWith('/')) {
      setBrowsePath(v)
    } else {
      commit(v)
      if (close) setOpen(false)
    }
  }
  const useThis = () => {
    if (browsePath) commit(browsePath)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="default" className="w-full justify-start font-mono" disabled={disabled}>
          <Folder className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left [direction:rtl]">{value || '选择目录'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-72 gap-2">
        {/* Breadcrumb: 根 returns to the roots list; each segment jumps to that level. */}
        <div className="text-muted-foreground flex flex-wrap items-center gap-0.5 text-xs">
          <button
            onClick={() => setBrowsePath('')}
            className={cn('hover:text-foreground flex items-center gap-1 rounded px-1 py-0.5', !browsePath && 'text-foreground')}
          >
            <Home className="size-3" /> 根
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className="flex items-center gap-0.5">
              <ChevronRight className="size-3 opacity-50" />
              <button onClick={() => setBrowsePath(c.path)} className="hover:text-foreground max-w-28 truncate rounded px-1 py-0.5">
                {c.name}
              </button>
            </span>
          ))}
        </div>

        {/* List area: roots, or the current dir's sub-directories. */}
        <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
          {loading && <div className="text-muted-foreground py-3 text-center text-xs">读取中…</div>}
          {!loading && err && <div className="text-muted-foreground py-3 text-center text-xs">进不去：{err}</div>}
          {!loading &&
            !err &&
            browsePath === '' &&
            roots.map((r) => (
              <button
                key={r.path}
                onClick={() => setBrowsePath(r.path)}
                className="hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]"
              >
                <Folder className="text-info size-4 shrink-0" />
                <span className="min-w-0 truncate">{r.label}</span>
                <span className="text-muted-foreground ml-auto max-w-[55%] truncate font-mono text-[11px] [direction:rtl]">{r.path}</span>
              </button>
            ))}
          {!loading && !err && browsePath === '' && !roots.length && (
            <div className="text-muted-foreground py-3 text-center text-xs">没有可浏览的目录</div>
          )}
          {!loading &&
            !err &&
            browsePath !== '' &&
            entries.map((e) => (
              <button
                key={e.name}
                onClick={() => setBrowsePath((browsePath === '/' ? '' : browsePath) + '/' + e.name)}
                className="hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]"
              >
                <Folder className="text-info size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
              </button>
            ))}
          {!loading && !err && browsePath !== '' && !entries.length && (
            <div className="text-muted-foreground py-3 text-center text-xs">没有子目录</div>
          )}
        </div>

        {/* Fallback: type or paste a path; Enter / blur commits. */}
        <div className="flex gap-2 border-t pt-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onBlur={() => loadManual(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                loadManual(true)
              }
            }}
            placeholder="手输 / 粘贴路径后回车（绝对路径会加载内容）"
            className="h-8 font-mono text-xs"
          />
          <Button size="default" onClick={useThis} disabled={!browsePath}>
            选用此目录
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
