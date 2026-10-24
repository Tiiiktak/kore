import { useCallback, useState } from 'react'

// Starred sessions (pin to top), local-only, keyed by node_ip/name. Same localStorage key
// as the old board so stars carry over.
const KEY = 'kore.stars'

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'))
  } catch {
    return new Set()
  }
}

export function useStars() {
  const [stars, setStars] = useState<Set<string>>(load)
  const toggle = useCallback((id: string) => {
    setStars((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])
  return { stars, toggle }
}
