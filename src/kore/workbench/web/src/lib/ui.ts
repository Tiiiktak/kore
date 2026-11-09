import { useSyncExternalStore } from 'react'

// App-level dialog flags. The dialogs render once (Overview / App), but several surfaces open them
// — the overview buttons, the ⌘K palette, the nav version label — so their open state lives here
// rather than in one component's useState.
export interface RenameTarget {
  kind: 'node' | 'session'
  key: string
  current: string
  placeholder: string
}
interface UiState {
  newSession: boolean
  adopt: boolean
  addMachine: boolean
  system: boolean
  leader: boolean
  rename: RenameTarget | null
}

let state: UiState = { newSession: false, adopt: false, addMachine: false, system: false, leader: false, rename: null }
const listeners = new Set<() => void>()

export function setUi(patch: Partial<UiState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}
