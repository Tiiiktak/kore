import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
} from 'lucide-react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'
import { toast } from 'sonner'
import { apiGet, kFsReadB, kFsWrite, TOKEN } from '@/lib/api'
import { baseName } from '@/lib/wm/store'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// File browser (Phase 2): the Phase-1 lazy react-arborist tree + syntax-highlighted preview,
// now with WRITES — new folder, rename, delete (hard rm, two-step confirm), chunked upload
// (any size), download, and image preview. All path policy stays on the node (koreops' fixed
// scripts); every write is audited. The frontend's two-step delete is anti-fat-finger, not a
// permission boundary.

interface Entry {
  name: string
  kind: 'dir' | 'file' | 'link' | 'other'
  size: number
  mtime: number
  target?: string
  broken?: boolean
}
// A tree node. `children === undefined` on a dir = not loaded yet (childrenAccessor returns []
// so it stays openable); a file's children is always null (a leaf).
interface FNode extends Entry {
  id: string
  path: string
  children?: FNode[]
}
interface ListResp {
  ok: boolean
  path: string
  entries: Entry[]
  truncated: boolean
  error?: string
}
interface ReadResp {
  ok: boolean
  text: string
  binary: boolean
  truncated: boolean
  size: number
  mtime: number
  error?: string
}

// Upload is chunked to stay under the node's single-argument execve limit; KEEP IN SYNC with
// koreops policy `fs.put_chunk_bytes` (a larger chunk here would be refused by the server).
const UPLOAD_CHUNK = 49152
const READB_CHUNK = 1024 * 1024 // one readb round trip (node caps at 1 MiB anyway)

function fmtSize(n: number): string {
  if (!(n >= 0)) return ''
  if (n < 1024) return n + ' B'
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    n /= 1024
    i++
  } while (n >= 1024 && i < u.length - 1)
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]
}
function fmtAge(t: number): string {
  if (!t) return ''
  const s = Math.max(0, Date.now() / 1000 - t)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前'
  const d = new Date(t * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const IMG_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif',
}
const CODE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'java',
  'rb', 'php', 'sh', 'bash', 'zsh', 'css', 'scss', 'less', 'html', 'xml', 'vue', 'svelte', 'json',
  'yml', 'yaml', 'toml', 'ini', 'sql', 'lua', 'kt', 'swift', 'md', 'r', 'pl',
])
const TEXT_EXT = new Set(['txt', 'log', 'cfg', 'conf', 'env', 'lock', 'gitignore', 'csv'])
const LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  tsx: 'typescript', py: 'python', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  hpp: 'cpp', java: 'java', rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  sql: 'sql', lua: 'lua', kt: 'kotlin', swift: 'swift', md: 'markdown',
}
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
const isImage = (name: string) => IMG_EXT.has(extOf(name))
function iconFor(n: FNode, open: boolean) {
  if (n.kind === 'dir') return open ? FolderOpen : Folder
  const e = extOf(n.name)
  if (IMG_EXT.has(e)) return ImageIcon
  if (CODE_EXT.has(e)) return FileCode
  if (TEXT_EXT.has(e)) return FileText
  return FileIcon
}
function highlight(text: string, name: string): string | null {
  if (text.length > 120_000) return null // too big to highlight snappily — show plain
  try {
    const lang = LANG[extOf(name)]
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
    return hljs.highlightAuto(text).value
  } catch {
    return null
  }
}

const noTrail = (p: string) => p.replace(/\/+$/, '') || '/'
const join = (dir: string, name: string) => (dir === '/' ? '' : noTrail(dir)) + '/' + name

// base64 <-> bytes, chunked so a large file never builds one giant intermediate string.
function base64FromBytes(u8: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode(...u8.subarray(i, Math.min(i + CH, u8.length)))
  }
  return btoa(s)
}
function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

// Immutably replace the loaded children of the node at `path` anywhere in the tree.
function setChildren(tree: FNode[], path: string, kids: FNode[]): FNode[] {
  return tree.map((n) => {
    if (n.path === path) return { ...n, children: kids }
    if (n.kind === 'dir' && n.children && path.startsWith(n.path + '/')) {
      return { ...n, children: setChildren(n.children, path, kids) }
    }
    return n
  })
}

// Row actions, provided down to the (stable, top-level) Row renderer via context so a
// right-click menu can act without react-arborist having to thread callbacks through.
interface RowActions {
  openFile: (n: FNode) => void
  onRename: (n: FNode) => void
  onDelete: (n: FNode) => void
  onDownload: (n: FNode) => void
  onNewFolder: (parentDir: string) => void
}
const RowCtx = createContext<RowActions | null>(null)

export function FilesView({
  nodeIp,
  root,
  mobile = false,
}: {
  winId: string
  nodeIp: string
  root: string
  path: string
  nodeName?: string
  mobile?: boolean
}) {
  const base = noTrail(root)
  const [tree, setTree] = useState<FNode[]>([])
  const [err, setErr] = useState('')
  const [loadingRoot, setLoadingRoot] = useState(true)
  const [filter, setFilter] = useState('')
  const [sel, setSel] = useState<FNode | null>(null)
  const [preview, setPreview] = useState<ReadResp | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const loadingRef = useRef<Set<string>>(new Set())
  const treeRef = useRef<TreeApi<FNode> | null>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imgUrlRef = useRef<string | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [dragOver, setDragOver] = useState(false)

  // Write dialogs / progress.
  const [renameFor, setRenameFor] = useState<FNode | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [delFor, setDelFor] = useState<FNode | null>(null)
  const [delCount, setDelCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [newFolderIn, setNewFolderIn] = useState<string | null>(null)
  const [newFolderVal, setNewFolderVal] = useState('')
  const [upload, setUpload] = useState<{ name: string; done: number; total: number; nth: number; of: number } | null>(null)

  const q = (p: string) => '/api/kore/fs/' + p + (p.includes('?') ? '&' : '?') + 'node_ip=' + encodeURIComponent(nodeIp)
  const parentOf = (path: string) => {
    if (path === base) return base
    const p = path.slice(0, path.lastIndexOf('/'))
    return p.length >= base.length ? p : base
  }
  // children stays `undefined` (unloaded) for everything; childrenAccessor derives leaf-ness
  // from kind, and onToggle distinguishes an unloaded dir (undefined) from a loaded-empty one ([]).
  const toNodes = (entries: Entry[], parent: string): FNode[] =>
    (entries || []).map((e) => ({ ...e, id: join(parent, e.name), path: join(parent, e.name) }))

  const fetchDir = useCallback(
    async (path: string) => {
      if (loadingRef.current.has(path)) return
      loadingRef.current.add(path)
      try {
        const d = await apiGet<ListResp>(q('list?path=' + encodeURIComponent(path)))
        const kids = d.ok ? toNodes(d.entries, path) : []
        if (path === base) {
          setErr(d.ok ? '' : d.error || '读取失败')
          setTree(kids)
        } else {
          setTree((prev) => setChildren(prev, path, kids))
        }
      } catch (e) {
        if (path === base) setErr((e as Error).message)
      } finally {
        loadingRef.current.delete(path)
        if (path === base) setLoadingRoot(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeIp, base],
  )

  // Re-fetch a dir that may already be loaded (after a write touched it).
  const reload = useCallback(
    async (dir: string) => {
      loadingRef.current.delete(dir)
      await fetchDir(dir)
    },
    [fetchDir],
  )

  useEffect(() => {
    setLoadingRoot(true)
    fetchDir(base)
  }, [fetchDir, base])

  useEffect(() => {
    const el = leftRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Release any object URL on unmount.
  useEffect(() => () => {
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
  }, [])

  const setImg = (url: string | null) => {
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current)
    imgUrlRef.current = url
    setImgUrl(url)
  }

  const onToggle = (id: string) => {
    const n = treeRef.current?.get(id)
    if (n && n.data.kind === 'dir' && n.data.children === undefined) fetchDir(id)
  }

  // Pull a whole file as bytes by looping readb on offset. Used by image preview + download.
  const fetchBytes = async (path: string, onProgress?: (done: number, total: number) => void): Promise<Uint8Array[]> => {
    const parts: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const r = await kFsReadB(nodeIp, path, offset, READB_CHUNK)
      if (!r.ok) throw new Error(r.error || '读取失败')
      parts.push(bytesFromBase64(r.data))
      offset += r.len
      onProgress?.(offset, r.size)
      if (r.eof || r.len === 0) break
    }
    return parts
  }

  const openFile = async (n: FNode, tail = false) => {
    setSel(n)
    setPreview(null)
    setImg(null)
    setPreviewing(true)
    try {
      if (isImage(n.name)) {
        const parts = await fetchBytes(n.path)
        const blob = new Blob(parts as BlobPart[], { type: IMG_MIME[extOf(n.name)] || 'application/octet-stream' })
        setImg(URL.createObjectURL(blob))
        setPreview({ ok: true, binary: true, text: '', truncated: false, size: n.size, mtime: n.mtime })
      } else {
        const d = await apiGet<ReadResp>(q('read?path=' + encodeURIComponent(n.path) + (tail ? '&tail=2000' : '')))
        setPreview(d)
      }
    } catch (x) {
      setPreview({ ok: false, error: (x as Error).message } as ReadResp)
    } finally {
      setPreviewing(false)
    }
  }

  const refresh = () => {
    loadingRef.current.clear()
    setSel(null)
    setPreview(null)
    setImg(null)
    setLoadingRoot(true)
    fetchDir(base)
  }

  // ---- writes ---------------------------------------------------------------------------
  const doRename = async () => {
    if (!renameFor) return
    const name = renameVal.trim()
    if (!name || name.includes('/')) {
      toast.error('名字不能为空或含「/」')
      return
    }
    const dir = parentOf(renameFor.path)
    const dst = join(dir, name)
    setBusy(true)
    try {
      await kFsWrite('rename', { node_ip: nodeIp, path: renameFor.path, dst })
      setRenameFor(null)
      toast('已重命名', { description: name })
      if (sel?.path === renameFor.path) {
        setSel(null)
        setPreview(null)
        setImg(null)
      }
      await reload(dir)
    } catch (e) {
      toast.error('重命名失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const askDelete = (n: FNode) => {
    setDelFor(n)
    setDelCount(null)
    if (n.kind === 'dir') {
      // Count entries so the confirm step can say how much a hard rm would take.
      apiGet<ListResp>(q('list?path=' + encodeURIComponent(n.path) + '&hidden=1'))
        .then((d) => setDelCount(d.ok ? d.entries.length : 0))
        .catch(() => setDelCount(0))
    }
  }

  const doDelete = async () => {
    if (!delFor) return
    const dir = parentOf(delFor.path)
    setBusy(true)
    try {
      await kFsWrite('delete', { node_ip: nodeIp, path: delFor.path })
      toast('已删除', { description: delFor.name })
      if (sel?.path === delFor.path) {
        setSel(null)
        setPreview(null)
        setImg(null)
      }
      setDelFor(null)
      await reload(dir)
    } catch (e) {
      toast.error('删除失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const doNewFolder = async () => {
    if (newFolderIn === null) return
    const name = newFolderVal.trim()
    if (!name || name.includes('/')) {
      toast.error('名字不能为空或含「/」')
      return
    }
    const dir = newFolderIn
    setBusy(true)
    try {
      await kFsWrite('mkdir', { node_ip: nodeIp, path: join(dir, name) })
      setNewFolderIn(null)
      setNewFolderVal('')
      toast('已新建文件夹', { description: name })
      await reload(dir)
      if (dir !== base) treeRef.current?.open(dir)
    } catch (e) {
      toast.error('新建失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const onDownload = async (n: FNode) => {
    const t = toast.loading('下载中…', { description: n.name })
    try {
      const parts = await fetchBytes(n.path, (done, total) =>
        toast.loading(`下载中 ${fmtSize(done)}${total ? ' / ' + fmtSize(total) : ''}`, { id: t, description: n.name }),
      )
      const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = n.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast.success('已下载', { id: t, description: n.name })
    } catch (e) {
      toast.error('下载失败', { id: t, description: (e as Error).message })
    }
  }

  // Sequential upload: each file is many `put` chunks (first truncates, rest append). No size
  // cap — the chunking is only to stay under the node's single-argument execve limit.
  const uploadFiles = async (files: File[], destDir: string) => {
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]
      const path = join(destDir, file.name)
      const buf = new Uint8Array(await file.arrayBuffer())
      const total = buf.length
      setUpload({ name: file.name, done: 0, total, nth: fi + 1, of: files.length })
      try {
        if (total === 0) {
          await kFsWrite('upload', { node_ip: nodeIp, path, data: '', append: false })
        } else {
          let off = 0
          let first = true
          while (off < total) {
            const slice = buf.subarray(off, Math.min(off + UPLOAD_CHUNK, total))
            await kFsWrite('upload', {
              node_ip: nodeIp,
              path,
              data: base64FromBytes(slice),
              append: !first,
            })
            off += slice.length
            first = false
            setUpload({ name: file.name, done: off, total, nth: fi + 1, of: files.length })
          }
        }
        toast.success('已上传', { description: file.name })
      } catch (e) {
        toast.error('上传失败', { description: `${file.name}：${(e as Error).message}` })
        break
      }
    }
    setUpload(null)
    await reload(destDir)
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file
    if (files.length) uploadFiles(files, base)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) uploadFiles(files, base)
  }

  const actions: RowActions = {
    openFile: (n) => openFile(n),
    onRename: (n) => {
      setRenameFor(n)
      setRenameVal(n.name)
    },
    onDelete: askDelete,
    onDownload,
    onNewFolder: (dir) => {
      setNewFolderIn(dir)
      setNewFolderVal('')
    },
  }

  const highlighted = preview?.ok && !preview.binary ? highlight(preview.text, sel?.name || '') : null
  const lineCount = preview?.ok && !preview.binary ? preview.text.split('\n').length : 0
  const canToken = !!TOKEN

  return (
    <RowCtx.Provider value={actions}>
      <div className="bg-card absolute inset-0 flex min-w-0 flex-col">
        <div className="bg-secondary flex shrink-0 items-center gap-2 px-2.5 py-1.5">
          <Folder className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={base}>
            {baseName(base) || base}
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤"
            aria-label="过滤文件名"
            className="bg-card text-foreground h-7 w-20 shrink-0 rounded-full px-2.5 text-xs outline-none ring-1 ring-[var(--border)] focus:ring-2"
          />
          <button
            onClick={() => actions.onNewFolder(base)}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-md"
            aria-label="新建文件夹"
            title="新建文件夹"
            disabled={!canToken}
          >
            <FolderPlus className="size-[18px]" />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-md"
            aria-label="上传文件"
            title="上传到当前根目录"
            disabled={!canToken}
          >
            <Upload className="size-[18px]" />
          </button>
          <button
            onClick={refresh}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-md"
            aria-label="刷新"
            title="刷新"
          >
            <RotateCw className={loadingRoot ? 'size-[18px] animate-spin' : 'size-[18px]'} />
          </button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles} />
        </div>

        {upload && (
          <div className="bg-secondary/60 text-muted-foreground flex shrink-0 items-center gap-2 px-3 py-1 text-[11px]">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              上传 {upload.of > 1 ? `(${upload.nth}/${upload.of}) ` : ''}
              {upload.name} · {fmtSize(upload.done)}
              {upload.total ? ' / ' + fmtSize(upload.total) : ''}
            </span>
            <span className="bg-card h-1.5 w-24 shrink-0 overflow-hidden rounded-full">
              <span
                className="block h-full rounded-full"
                style={{
                  width: upload.total ? `${Math.round((upload.done / upload.total) * 100)}%` : '100%',
                  background: 'var(--brand)',
                }}
              />
            </span>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div
            ref={leftRef}
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragOver) setDragOver(true)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragOver(false)
            }}
            onDrop={onDrop}
            className={cn(
              'relative overflow-hidden',
              mobile ? (sel ? 'hidden' : 'min-w-0 flex-1') : 'min-w-[200px] basis-[40%] border-r',
            )}
          >
            {dragOver && (
              <div className="bg-accent/70 text-foreground pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg text-xs font-medium ring-2 ring-[var(--brand)]">
                松开上传到 {baseName(base) || base}
              </div>
            )}
            {err && <div className="text-muted-foreground p-6 text-center text-xs">{err}</div>}
            {!err && loadingRoot && <div className="text-muted-foreground p-6 text-center text-xs">读取中…</div>}
            {!err && !loadingRoot && tree.length === 0 && (
              <div className="text-muted-foreground p-6 text-center text-xs">空目录</div>
            )}
            {!err && !loadingRoot && tree.length > 0 && box.w > 0 && box.h > 0 && (
              <Tree<FNode>
                ref={treeRef}
                data={tree}
                idAccessor="path"
                childrenAccessor={(d) => (d.kind === 'dir' ? (d.children ?? []) : null)}
                openByDefault={false}
                width={box.w}
                height={box.h}
                indent={14}
                rowHeight={28}
                padding={6}
                searchTerm={filter}
                disableDrag
                disableEdit
                disableMultiSelection
                onToggle={onToggle}
                onActivate={(n) => {
                  if (n.data.kind === 'dir') n.toggle()
                  else if (!n.data.broken) openFile(n.data)
                }}
              >
                {Row}
              </Tree>
            )}
          </div>

          <div className={cn('bg-card flex min-w-0 flex-1 flex-col', mobile && !sel && 'hidden')}>
            {!sel && <div className="text-muted-foreground p-8 text-center text-sm">选一个文件预览</div>}
            {sel && (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 px-3">
                  {mobile && (
                    <button
                      onClick={() => {
                        setSel(null)
                        setPreview(null)
                        setImg(null)
                      }}
                      aria-label="返回文件树"
                      className="text-muted-foreground hover:bg-accent hover:text-foreground -ml-1 flex size-7 shrink-0 items-center justify-center rounded-md"
                    >
                      <ChevronLeft className="size-[18px]" />
                    </button>
                  )}
                  <span className="truncate text-[13px] font-medium" title={sel.path}>
                    {sel.name}
                  </span>
                  <span className="text-muted-foreground mr-auto shrink-0 text-[11px] tabular-nums">
                    {fmtSize(sel.size)} · {fmtAge(sel.mtime)}
                  </span>
                  <button
                    onClick={() => onDownload(sel)}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md"
                    aria-label="下载"
                    title="下载"
                  >
                    <Download className="size-4" />
                  </button>
                </div>
                <div className="relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-md bg-[#0d1117]">
                  {previewing && (
                    <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-xs">
                      <Loader2 className="mr-1.5 size-4 animate-spin" /> 读取中…
                    </div>
                  )}
                  {preview && !preview.ok && (
                    <div className="p-4 text-xs text-[#8b949e]">读不到：{preview.error}</div>
                  )}
                  {preview?.ok && imgUrl && (
                    <div className="flex h-full items-center justify-center overflow-auto p-3">
                      <img src={imgUrl} alt={sel.name} className="max-h-full max-w-full object-contain" />
                    </div>
                  )}
                  {preview?.ok && !imgUrl && preview.binary && (
                    <div className="p-4 text-xs text-[#8b949e]">
                      二进制文件，暂不预览（{fmtSize(preview.size)}）·{' '}
                      <button className="text-[#58a6ff] underline" onClick={() => onDownload(sel)}>
                        下载
                      </button>
                    </div>
                  )}
                  {preview?.ok && !preview.binary && (
                    <div className="flex h-full flex-col">
                      {preview.truncated && (
                        <div className="shrink-0 bg-[#1c2128] px-3 py-1.5 text-[11px] text-[#8b949e]">
                          文件较大，只显示开头 ·{' '}
                          <button className="text-[#58a6ff] underline" onClick={() => openFile(sel, true)}>
                            看结尾
                          </button>
                        </div>
                      )}
                      <div className="min-h-0 flex-1 overflow-auto">
                        <div className="flex min-w-max font-mono text-[12px] leading-[1.6]">
                          <pre className="shrink-0 select-none border-r border-[#21262d] px-2 py-2 text-right text-[#484f58]">
                            {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
                          </pre>
                          {highlighted !== null ? (
                            <pre className="hljs flex-1 bg-transparent px-3 py-2 !whitespace-pre">
                              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                            </pre>
                          ) : (
                            <pre className="flex-1 px-3 py-2 whitespace-pre text-[#e6edf3]">{preview.text}</pre>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Rename */}
      <Dialog open={!!renameFor} onOpenChange={(v) => !v && setRenameFor(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">{renameFor?.path}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && doRename()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFor(null)}>
              取消
            </Button>
            <Button onClick={doRename} disabled={busy}>
              重命名
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New folder */}
      <Dialog open={newFolderIn !== null} onOpenChange={(v) => !v && setNewFolderIn(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">
              在 {newFolderIn} 下
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newFolderVal}
            onChange={(e) => setNewFolderVal(e.target.value)}
            placeholder="文件夹名"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && doNewFolder()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderIn(null)}>
              取消
            </Button>
            <Button onClick={doNewFolder} disabled={busy}>
              新建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete — step two of a two-step confirm (hard rm, no trash). */}
      <Dialog open={!!delFor} onOpenChange={(v) => !v && setDelFor(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>删除{delFor?.kind === 'dir' ? '文件夹' : '文件'}？</DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">{delFor?.path}</DialogDescription>
          </DialogHeader>
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
            硬删除，不进回收站，无法恢复。
            {delFor?.kind === 'dir' &&
              (delCount === null ? ' 正在统计…' : delCount > 0 ? ` 这个文件夹含 ${delCount} 项，会一并删除。` : ' 空文件夹。')}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelFor(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={busy}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RowCtx.Provider>
  )
}

// One tree row: indent handled by react-arborist via `style`; chevron for dirs, type icon, name,
// and size/age on the right. Focus = a tinted block (never a one-sided edge). Right-click opens
// a context menu (rename / delete / download; dirs get 新建子文件夹).
function Row({ node, style }: NodeRendererProps<FNode>) {
  const d = node.data
  const dir = d.kind === 'dir'
  const actions = useContext(RowCtx)
  const Icon = iconFor(d, node.isOpen)
  const fresh = !dir && d.mtime && Date.now() / 1000 - d.mtime < 300
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          style={style}
          title={d.name + (d.target ? ' → ' + d.target : '')}
          className={cn(
            'flex h-7 cursor-pointer items-center gap-1 rounded-md pr-2 text-[13px]',
            node.isSelected ? 'bg-accent text-foreground' : 'hover:bg-accent/60',
            d.broken && 'text-muted-foreground line-through',
          )}
        >
          <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
            {dir && (node.isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}
          </span>
          <Icon className={cn('size-4 shrink-0', dir ? 'text-[var(--done)]' : 'text-muted-foreground')} />
          <span className={cn('min-w-0 flex-1 truncate', dir && 'font-medium')}>
            {d.name}
            {fresh && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: 'var(--brand)' }} />
            )}
          </span>
          {!dir && <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{fmtSize(d.size)}</span>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {dir && (
          <>
            <ContextMenuItem onSelect={() => actions?.onNewFolder(d.path)}>
              <FolderPlus /> 新建子文件夹
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!dir && !d.broken && (
          <ContextMenuItem onSelect={() => actions?.onDownload(d)}>
            <Download /> 下载
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => actions?.onRename(d)}>
          <Pencil /> 重命名
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => actions?.onDelete(d)}>
          <Trash2 /> 删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
