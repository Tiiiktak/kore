import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCw } from 'lucide-react'
import { normUrl, proxyUrl } from '@/lib/wm/web'
import { wmStore } from '@/lib/wm/store'

// Browser window: address bar + sandboxed iframe fed by the board's reverse proxy.
export function BrowserView({ winId, url: initial }: { winId: string; url?: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [value, setValue] = useState(initial || '')
  const [url, setUrl] = useState(initial || '')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!url) return
    let alive = true
    setLoading(true)
    proxyUrl(url)
      .then((src) => {
        if (alive && frameRef.current) frameRef.current.src = src
      })
      .catch(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [url])

  const go = () => {
    const u = normUrl(value)
    if (!u) return
    setValue(u)
    setUrl(u)
    wmStore.setWin(winId, 'web', { url: u })
  }

  return (
    <div className="bg-card absolute inset-0 flex flex-col">
      <div className="bg-secondary flex shrink-0 items-center gap-1 px-1.5 py-1.5">
        <button
          onClick={() => (url ? setUrl(url + '') : go())}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-md"
          aria-label="刷新"
        >
          <RotateCw className={loading ? 'size-5 animate-spin' : 'size-5'} />
        </button>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go()
            } else if (e.key === 'Escape') {
              setValue(url)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          autoComplete="off"
          placeholder="5173、localhost:8080 或内部服务地址"
          aria-label="地址"
          className="bg-card text-foreground placeholder:text-muted-foreground focus:ring-ring h-7 min-w-0 flex-1 rounded-full px-3 text-xs outline-none ring-1 ring-[var(--border)] focus:ring-2"
        />
        <button
          onClick={() => url && window.open(url, '_blank', 'noopener')}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-md"
          aria-label="在新标签页打开"
        >
          <ExternalLink className="size-5" />
        </button>
      </div>
      <iframe
        ref={frameRef}
        onLoad={() => setLoading(false)}
        className="min-h-0 flex-1 bg-[var(--panel,#fff)]"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        title="浏览器窗口"
      />
    </div>
  )
}
