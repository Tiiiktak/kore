import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, setKorePrefix } from '@/lib/api'
import type { Roster } from '@/lib/types'

export interface RosterState {
  roster: Roster | null
  loading: boolean
  error: string | null
  refreshing: boolean
  fetchedAt: number | null
  refresh: () => void
}

// Reads /api/kore/roster. First load uses the cached cluster scan (fast); the refresh button
// forces a real re-scan (force=1). A light 10s poll keeps the cached view fresh without
// forcing per-node round trips (matches the old board's kTick cadence).
export function useRoster(pollMs = 10_000): RosterState {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const busy = useRef(false)

  const load = useCallback(async (force: boolean) => {
    if (busy.current) return
    busy.current = true
    if (force) setRefreshing(true)
    try {
      const r = await apiGet<Roster>(`/api/kore/roster?scan=cluster${force ? '&force=1' : ''}`)
      setKorePrefix(r.prefix)
      setRoster(r)
      setError(r.ok === false ? r.error || '读取失败' : null)
      setFetchedAt(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      busy.current = false
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(false)
    const id = setInterval(() => load(false), pollMs)
    return () => clearInterval(id)
  }, [load, pollMs])

  return { roster, loading, error, refreshing, fetchedAt, refresh: () => load(true) }
}
