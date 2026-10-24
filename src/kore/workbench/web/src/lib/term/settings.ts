// Terminal font + renderer prefs, same localStorage keys as the old board so they carry over.
const FONT_KEY = 'kore.pane.font'
const RENDERER_KEY = 'kore.pane.renderer'
const FONT_MIN = 8
const FONT_MAX = 24

const isTouch = (() => {
  try {
    return matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
})()

export function fontGet(): number {
  let raw = ''
  try {
    raw = localStorage.getItem(FONT_KEY) || ''
  } catch {
    /* ignore */
  }
  const f = parseFloat(raw)
  return Number.isFinite(f)
    ? Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(f)))
    : isTouch
      ? 13
      : 12
}

export function fontSet(px: number): number {
  const want = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)))
  try {
    localStorage.setItem(FONT_KEY, String(want))
  } catch {
    /* ignore */
  }
  return want
}

export type Renderer = 'auto' | 'dom' | 'webgl'
export function rendererGet(): Renderer {
  try {
    const v = localStorage.getItem(RENDERER_KEY)
    if (v === 'dom' || v === 'webgl' || v === 'auto') return v
  } catch {
    /* ignore */
  }
  return 'auto'
}

// WebGL glyph atlas is blurry at non-integer devicePixelRatio (xterm #2662); auto picks DOM there.
export function wantsWebgl(): boolean {
  const m = rendererGet()
  if (m === 'dom') return false
  if (m === 'webgl') return true
  return Number.isInteger(window.devicePixelRatio || 1)
}
