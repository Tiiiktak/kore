import { useSyncExternalStore } from 'react'
import { sessKey } from '@/lib/kore'
import type { Session } from '@/lib/types'

// The one-shot "刚干完，去看看" indicator. When a session finishes a turn it enters a fresh
// idle stretch (a new `state_since` from the hook record). Until the user opens/looks at that
// session, its dot shows the distinct "done" colour; once seen it falls back to plain idle.
//
// "Seen" is tracked by remembering the `state_since` value acknowledged for each session —
// comparing backend `since` to backend `since`, never a wall clock, so node/client clock skew
// can't break it. Persisted so the reminder survives a reload.
const KEY = 'kore.seen.v1'

function load(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

let seen: Record<string, number> = load()
let version = 0
const subs = new Set<() => void>()

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen))
  } catch {
    /* private mode / quota — the reminder just won't persist */
  }
}

export const seenStore = {
  subscribe(fn: () => void) {
    subs.add(fn)
    return () => subs.delete(fn)
  },
  version: () => version,
  // Acknowledge a session at its current idle-stretch identity (called while it's on screen).
  markSeen(key: string, since: number | undefined) {
    if (since == null || seen[key] === since) return
    seen[key] = since
    save()
    version++
    subs.forEach((f) => f())
  },
  isUnseen(key: string, since: number | undefined): boolean {
    return since != null && seen[key] !== since
  },
}

export function useSeenVersion(): number {
  return useSyncExternalStore(seenStore.subscribe, seenStore.version, seenStore.version)
}

// The dot state to render: a fresh, unseen, finished (idle) session that is NOT currently on
// screen shows "done"; everything else is its raw roster state.
export function effectiveState(s: Session, visible: Set<string>): string {
  if (s.state !== 'idle') return s.state
  const key = sessKey(s)
  if (visible.has(key)) return 'idle'
  return seenStore.isUnseen(key, s.state_since) ? 'done' : 'idle'
}
