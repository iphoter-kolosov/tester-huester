// Keyboard isolation for the in-page overlay. The overlay lives in a shadow root ON SOMEONE ELSE'S PAGE, and a
// key event typed into our note bubbles out of the shadow root to the host's document and window. Sites bind
// keys there all the time — a map pans on Space, a docs site jumps to search on "/", a player pauses on "k" —
// and the usual guard ("if target is an input, skip") fails for us: across a shadow boundary the host sees the
// event retargeted to our host <div>, not to a textarea. 30.10.2026: balatonmap.ihor.work cancelled Space, so
// the owner could type every letter of a report except the spaces between words.
//
// Two layers:
//   1. Stop the event at our shadow host: bubbling listeners of the page (document, window, body) never see it.
//   2. A page listener that ran BEFORE us (capture phase on window/document) can still have cancelled the
//      keystroke. Then the character is lost — so we type it ourselves at the caret, the way the browser would.

const EVENTS = ['keydown', 'keypress', 'keyup'] as const

/** The element the key was actually typed into, if it is a text field of ours. */
export function editableTarget(e: Event): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const t = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null
  if (!t || typeof t !== 'object') return null
  const tag = t.tagName
  if (tag === 'TEXTAREA') return t
  if (tag === 'INPUT') {
    // Only fields with a caret API (setRangeText): email/number have none, a checkbox or slider takes no text.
    const type = ((t as HTMLInputElement).type || 'text').toLowerCase()
    return ['text', 'search', 'url', 'tel', 'password'].includes(type) ? t : null
  }
  return t.isContentEditable ? t : null
}

/** A keydown that, left alone, would put exactly this text into the field (null for keys that do not type). */
export function typedText(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): string | null {
  if (e.isComposing || e.ctrlKey || e.metaKey) return null
  // AltGr layouts (HU: AltGr+Q = "\") report ctrlKey+altKey on Windows and are already excluded above; a plain
  // Alt+letter on macOS types a real character (Option+a = "å"), so Alt alone is not a reason to skip.
  return [...e.key].length === 1 ? e.key : null
}

/** Insert `text` at the caret of `el` and announce it like real typing (drafts and autosave listen to input). */
export function insertAtCaret(el: HTMLElement, text: string): void {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const f = el as HTMLInputElement | HTMLTextAreaElement
    const start = f.selectionStart ?? f.value.length
    const end = f.selectionEnd ?? start
    f.setRangeText(text, start, end, 'end')
  } else {
    // contenteditable: replace the selection with a text node, caret after it.
    const sel = (el.ownerDocument.defaultView ?? window).getSelection()
    if (!sel || !sel.rangeCount) return
    const r = sel.getRangeAt(0)
    r.deleteContents()
    const node = el.ownerDocument.createTextNode(text)
    r.insertNode(node)
    r.setStartAfter(node)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
}

/**
 * Keep the keyboard inside `host` while the tester types in one of its fields. Returns the undo function.
 * Hotkeys of the overlay itself keep working: they listen in the capture phase above this point.
 */
export function isolateKeys(host: HTMLElement): () => void {
  const onKey = (e: Event): void => {
    const field = editableTarget(e)
    if (!field) return
    e.stopPropagation()
    if (e.type !== 'keydown' || !e.defaultPrevented) return
    const ke = e as KeyboardEvent
    // Our own handlers cancel Enter/Escape on purpose; they never cancel a printable key, so a cancelled
    // printable key here can only be the host page's doing.
    const text = typedText(ke)
    if (text !== null) insertAtCaret(field, text)
  }
  for (const t of EVENTS) host.addEventListener(t, onKey)
  return () => { for (const t of EVENTS) host.removeEventListener(t, onKey) }
}
