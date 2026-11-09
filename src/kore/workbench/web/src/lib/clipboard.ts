// Copy text to the clipboard, working on a plain-http board too. `navigator.clipboard` only
// exists in a secure context (HTTPS / localhost), and the board is usually opened as
// http://<ip>:8198 — there it is undefined and a bare `navigator.clipboard?.writeText` does
// nothing at all. So try the legacy execCommand path first (works anywhere, inside a user
// gesture), then the async API. Resolves true iff the text landed.
export async function copyText(text: string): Promise<boolean> {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  const prev = document.activeElement as HTMLElement | null
  // Inside a modal (Radix Dialog), its focus trap pulls focus back from anything outside it,
  // so a textarea on <body> never holds the selection and execCommand "succeeds" copying
  // nothing. Put it inside the dialog the click came from.
  ;(prev?.closest('[role="dialog"]') ?? document.body).appendChild(ta)
  let ok = false
  try {
    ta.focus() // execCommand copies the FOCUSED selection; select() alone isn't enough everywhere
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  prev?.focus?.()
  if (ok) return true
  if (!navigator.clipboard?.writeText) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
