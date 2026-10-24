// Theme: light | dark | auto, stored in localStorage 'kore.theme'. Applies by toggling the
// `.dark` class on <html> (shadcn/Tailwind dark variant). Mirrors the old board's contract.
export type Theme = 'light' | 'dark' | 'auto'
const KEY = 'kore.theme'

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    /* ignore */
  }
  return 'auto'
}

export function prefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function isDark(t: Theme = getTheme()): boolean {
  return t === 'dark' || (t === 'auto' && prefersDark())
}

export function applyTheme(t: Theme = getTheme()): void {
  document.documentElement.classList.toggle('dark', isDark(t))
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* ignore */
  }
  applyTheme(t)
}
