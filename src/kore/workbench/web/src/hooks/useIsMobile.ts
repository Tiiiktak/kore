import { useEffect, useState } from 'react'

// Narrow / touch screens: the stage degrades to a single full-bleed window + a switcher,
// and terminals get a key bar. 720px matches the old board's single-column breakpoint.
export function useIsMobile(bp = 720): boolean {
  const q = `(max-width: ${bp}px)`
  const [m, setM] = useState(() => {
    try {
      return matchMedia(q).matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    const mq = matchMedia(q)
    const h = () => setM(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [q])
  return m
}
