import { useEffect, useState } from 'react'

// Soft-keyboard height via visualViewport. When the keyboard opens the layout viewport stays
// put but visualViewport shrinks; we return how many px the keyboard covers so the mobile stage
// can lift its content above it (Termux-style key row on top of the keyboard). 0 on desktop.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const sync = () => {
      const kb = Math.round(window.innerHeight - vv.height - vv.offsetTop)
      setInset(kb > 40 ? kb : 0) // >40px to ignore browser-chrome jitter
    }
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    sync()
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
    }
  }, [])
  return inset
}
