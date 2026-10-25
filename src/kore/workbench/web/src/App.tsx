import { useEffect, useState } from 'react'
import { Chrome } from '@/components/Chrome'
import { Overview, type OpenPayload } from '@/components/overview/Overview'
import { WmStage } from '@/components/wm/WmStage'
import { CommandPalette } from '@/components/CommandPalette'
import { RosterProvider, useRosterCtx } from '@/lib/roster-context'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import { useTabSide } from '@/lib/layout'
import { useIsMobile } from '@/hooks/useIsMobile'
import { nodeName as nodeNameOf, sessKey } from '@/lib/kore'
import { seenStore } from '@/lib/seen'
import { apiGet } from '@/lib/api'

function Shell() {
  const [version, setVersion] = useState<string>()
  const wmVersion = useWmVersion()
  const { roster } = useRosterCtx()
  const side = useTabSide()
  const mobile = useIsMobile()
  const leftRail = side === 'left' && !mobile
  const home = wmStore.get().view === 'home'

  useEffect(() => {
    apiGet<{ version?: string }>('/api/kore/roster?scan=registry')
      .then((r) => setVersion(r.version))
      .catch(() => {})
  }, [])

  // Keep workspace tabs in sync with reality: if a session was killed (gone from the roster on
  // a reachable node), drop its window from every workspace.
  useEffect(() => {
    if (!roster || roster.ok === false) return
    const alive = new Set((roster.sessions || []).map((s) => s.node_ip + '/' + s.name))
    const reachable = new Set((roster.nodes || []).map((n) => n.node_ip))
    wmStore.pruneSessions(alive, reachable)
  }, [roster])

  // Clear the one-shot "done" reminder for any session currently on screen: looking at a
  // session acknowledges its latest finish. Runs on roster ticks and on focus/layout changes.
  useEffect(() => {
    if (!roster || roster.ok === false) return
    const vis = wmStore.visibleSessionKeys()
    if (!vis.size) return
    for (const s of roster.sessions || []) {
      if (vis.has(sessKey(s))) seenStore.markSeen(sessKey(s), s.state_since)
    }
  }, [roster, wmVersion])

  const openSession = (p: OpenPayload) =>
    wmStore.openSession({
      node_ip: p.session.node_ip,
      name: p.session.name,
      writable: p.session.writable,
      label: p.labels.sessions[p.session.node_ip + '/' + p.session.name]?.name,
      node: nodeNameOf(p.session.node_ip, p.nodes, p.labels),
    })

  const content = (
    <main className="relative min-h-0 flex-1">
      {/* Overview stays mounted (keeps polling); the stage overlays it when not home. The two
          cross-fade on the home↔session switch instead of hard-cutting, and the stage eases in
          (fade + slight rise) as it mounts. */}
      <div
        className={`absolute inset-0 transition-opacity duration-200 ease-out ${home ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <Overview onOpen={openSession} />
      </div>
      {!home && (
        <div className="absolute inset-0 [animation:viewIn_.24s_ease-out]">
          <WmStage />
        </div>
      )}
    </main>
  )
  return (
    <>
      <div className={leftRail ? 'flex h-dvh overflow-hidden' : 'flex h-dvh flex-col overflow-hidden'}>
        <Chrome version={version} orientation={leftRail ? 'left' : 'top'} />
        {content}
      </div>
      <CommandPalette />
    </>
  )
}

export default function App() {
  return (
    <RosterProvider>
      <Shell />
    </RosterProvider>
  )
}
