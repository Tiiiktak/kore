import { useSyncExternalStore } from 'react'

// Tab-bar position: 'top' (horizontal header) or 'left' (vertical sidebar). Same localStorage
// key as the old board ('kore.tabs' === 'left'). Module store so the toggle anywhere updates all.
export type TabSide = 'top' | 'left'
const KEY = 'kore.tabs'
let side: TabSide = (() => {
  try {
    return localStorage.getItem(KEY) === 'left' ? 'left' : 'top'
  } catch {
    return 'top'
  }
})()
const listeners = new Set<() => void>()

export function setTabSide(s: TabSide) {
  side = s
  try {
    localStorage.setItem(KEY, s)
  } catch {
    /* ignore */
  }
  for (const l of listeners) l()
}
export function toggleTabSide() {
  setTabSide(side === 'left' ? 'top' : 'left')
}
export function useTabSide(): TabSide {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => side,
  )
}
