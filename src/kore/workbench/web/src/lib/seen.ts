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

// --- optimistic "I just acted on this" suppression for the waiting blink --------------------
// Opening a waiting session, or sending it any input, records a wall-clock instant here. While
// that instant is NEWER than the roster snapshot being rendered (its `fetchedAt`), the session is
// shown as busy instead of blinking "需要你". The first roster read that post-dates the action
// wins — so a prompt you really answered stops blinking at once, while one still on screen (or
// answered elsewhere but not yet rescanned) correctly resumes. Same client clock on both sides,
// so no skew. Not persisted: a reload re-reads the real state, which is what you'd want.
const acted = new Map<string, number>()

export function markActed(key: string): void {
  const now = Date.now()
  const prev = acted.get(key)
  acted.set(key, now)
  // coalesce re-renders during continuous typing — the dot only needs to flip once per episode
  if (prev == null || now - prev > 2000) {
    version++
    subs.forEach((f) => f())
  }
}

function actedAfter(key: string, fetchedAt: number | null): boolean {
  const t = acted.get(key)
  return t != null && (fetchedAt == null || t > fetchedAt)
}

// The dot state to render. `waiting`: suppressed to busy if the user acted after this snapshot
// (see above). A fresh, unseen, finished (idle) session not currently on screen shows "done";
// everything else is its raw roster state. Pass `fetchedAt` (roster snapshot time) for the
// waiting suppression to work; omit it and waiting always shows.
export function effectiveState(s: Session, visible: Set<string>, fetchedAt: number | null = null): string {
  const key = sessKey(s)
  if (s.state === 'waiting') return actedAfter(key, fetchedAt) ? 'busy' : 'waiting'
  if (s.state !== 'idle') return s.state
  if (visible.has(key)) return 'idle'
  return seenStore.isUnseen(key, s.state_since) ? 'done' : 'idle'
}
