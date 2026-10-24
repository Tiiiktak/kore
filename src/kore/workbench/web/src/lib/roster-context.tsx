import { createContext, useContext, type ReactNode } from 'react'
import { useRoster, type RosterState } from '@/hooks/useRoster'

const Ctx = createContext<RosterState | null>(null)

export function RosterProvider({ children }: { children: ReactNode }) {
  const state = useRoster()
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export function useRosterCtx(): RosterState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRosterCtx outside RosterProvider')
  return v
}
