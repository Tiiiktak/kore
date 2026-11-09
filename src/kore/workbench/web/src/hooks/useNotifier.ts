import { useEffect, useRef } from 'react'
import { useRosterCtx } from '@/lib/roster-context'
import { effectiveState } from '@/lib/seen'
import { wmStore } from '@/lib/wm/store'
import { STATE_LABEL, buildNodes, emptyLabels, nodeName, sessKey, sessName } from '@/lib/kore'
import { notify } from '@/lib/notify'

// Edge-triggered notification driver. Mounted once (in Shell), it watches the roster poll and
// fires a notification the moment a session ENTERS a notify-worthy state (waiting / done) — not
// on every 6s tick. Dedup is by the backend `state_since` of that stretch (same trick as
// seen.ts: compare backend `since` to backend `since`, never a wall clock).
//
//  • The first roster snapshot only SEEDS the known-since map — it never notifies, so a reload
//    or a freshly opened page doesn't blast alerts for states that were already there.
//  • A session you're currently looking at (in visibleSessionKeys) is skipped — you can see it.
//  • notify() itself filters by the user's prefs/channels, so a disabled channel still advances
//    the seen-since map here (no backfill when the user later flips a toggle on).
export function useNotifier(): void {
  const { roster, fetchedAt } = useRosterCtx()
  // key -> the state_since we've already acted on. Edge = a session whose current notify-worthy
  // stretch has a since we haven't recorded yet.
  const known = useRef<Map<string, number>>(new Map())
  const seeded = useRef(false)

  useEffect(() => {
    if (!roster || roster.ok === false) return
    const sessions = roster.sessions || []
    const labels = roster.labels || emptyLabels
    const prefix = roster.prefix || 'kore-'
    const nodes = buildNodes(roster.nodes || [])
    const visible = wmStore.visibleSessionKeys()

    for (const s of sessions) {
      const eff = effectiveState(s, visible, fetchedAt)
      if (eff !== 'waiting' && eff !== 'done') continue
      const key = sessKey(s)
      const since = s.state_since ?? 0
      if (known.current.get(key) === since) continue // already handled this stretch
      known.current.set(key, since)
      if (!seeded.current) continue // first snapshot: seed only
      if (visible.has(key)) continue // you're looking at it

      const name = sessName(s, labels, prefix)
      const node = nodeName(s.node_ip, nodes, labels)
      notify({
        kind: eff,
        key,
        title: eff === 'waiting' ? `${name} ${STATE_LABEL.waiting}` : `${name} ${STATE_LABEL.done}`,
        body: eff === 'waiting' ? `${node} · 等待你回复` : `${node} · 刚完成一轮`,
        onClick: () =>
          wmStore.openSession({
            node_ip: s.node_ip,
            name: s.name,
            writable: s.writable,
            label: labels.sessions[key]?.name,
            node,
          }),
      })
    }
    seeded.current = true
  }, [roster, fetchedAt])
}
