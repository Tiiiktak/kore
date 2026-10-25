// Minimal FLIP (First-Last-Invert-Play) for the nav controls when the tab bar flips between
// top and left. The shared background never moves; only the controls — overview, each
// workspace tab, new-workspace, version, settings — slide from where they WERE to where they
// now ARE. Elements opt in with a stable `data-flip="<key>"`. We match by key, so it works
// even though React swaps the DOM node between the top/left layouts. logo + the toggle button
// carry no key, so they don't move.
//
// Usage: flipCapture() right before flipping the side, flipPlay() in a layout effect after.
const prev = new Map<string, DOMRect>()

export function flipCapture(): void {
  prev.clear()
  for (const el of document.querySelectorAll<HTMLElement>('[data-flip]')) {
    if (el.dataset.flip) prev.set(el.dataset.flip, el.getBoundingClientRect())
  }
}

export function flipPlay(duration = 320): void {
  if (!prev.size) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  for (const el of document.querySelectorAll<HTMLElement>('[data-flip]')) {
    const key = el.dataset.flip
    const first = key ? prev.get(key) : undefined
    if (!first) continue
    const last = el.getBoundingClientRect()
    const dx = first.left - last.left
    const dy = first.top - last.top
    if (reduce || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) continue
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
      duration,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    })
  }
  prev.clear()
}
