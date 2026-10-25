import { useEffect, useState } from 'react'
import { kSysinfo, type NodeMetrics } from '@/lib/api'

// Per-node system metrics (load/cpu/mem/disk/gpu) for the overview, on their OWN cadence —
// faster than the roster and backed by a short server-side cache, so it never forces a cluster
// rescan. Returns the ip -> metrics map; a failed tick just keeps the last values.
export function useSysinfo(pollMs = 8000): Record<string, NodeMetrics> {
  const [nodes, setNodes] = useState<Record<string, NodeMetrics>>({})
  useEffect(() => {
    let alive = true
    const load = () =>
      kSysinfo()
        .then((r) => {
          if (alive) setNodes(r.nodes || {})
        })
        .catch(() => {})
    load()
    const id = setInterval(load, pollMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [pollMs])
  return nodes
}
