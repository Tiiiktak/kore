import { useEffect, useLayoutEffect } from 'react'
import { Chrome } from '@/components/Chrome'
import { Overview, type OpenPayload } from '@/components/overview/Overview'
import { WmStage } from '@/components/wm/WmStage'
import { CommandPalette } from '@/components/CommandPalette'
import { TmuxLeaderMenu } from '@/components/wm/TmuxLeaderMenu'
import { RosterProvider, useRosterCtx } from '@/lib/roster-context'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import { useTabSide } from '@/lib/layout'
import { flipPlay } from '@/lib/wm/flip'
import { useIsMobile } from '@/hooks/useIsMobile'
import { nodeName as nodeNameOf, sessKey } from '@/lib/kore'
import { seenStore } from '@/lib/seen'

function Shell() {
  const wmVersion = useWmVersion()
  const { roster } = useRosterCtx()
  const side = useTabSide()
  const mobile = useIsMobile()
  const leftRail = side === 'left' && !mobile
  const home = wmStore.get().view === 'home'
  // The installed build string rides the normal roster poll (roster carries `version`), so it
  // self-heals after an upgrade+restart — no page reload, no separate one-shot fetch.
  const version = roster?.version

  // When the tab bar flips top↔left, slide the nav controls (overview, tabs, new-workspace,
  // version, settings) from their old positions to their new ones. The shared background and
  // the logo/toggle don't move; flipCapture() ran in the toggle's onClick just before this.
  useLayoutEffect(() => {
    flipPlay()
  }, [side])

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
    <main
      className={`absolute right-0 bottom-0 transition-[top,left] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${leftRail ? 'top-0 left-[228px]' : 'top-[46px] left-0'}`}
    >
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
      <div className="bg-background relative h-dvh overflow-hidden">
        <Chrome version={version} orientation={leftRail ? 'left' : 'top'} />
        {content}
      </div>
      <CommandPalette />
      <TmuxLeaderMenu />
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
