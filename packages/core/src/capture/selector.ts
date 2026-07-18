import { finder } from '@medv/finder'
import type { SelectorCandidates } from './types.js'

// One clicked element → several ways to find it again. The CSS path (from @medv/finder) is exact but
// brittle; role+name+text+testid are what survive a redesign, and what an AI agent / Playwright locator
// prefers (getByRole, getByText, getByTestId). We record all of them so the downstream consumer picks.
export function bestSelector(el: Element): SelectorCandidates {
  let css: string
  try {
    css = finder(el, { seedMinLength: 4, optimizedMinLength: 2 })
  } catch {
    css = fallbackCss(el)
  }
  const role = el.getAttribute('role') || implicitRole(el)
  const name = accessibleName(el)
  const text = shortText(el)
  const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || undefined
  return {
    css,
    role: role || undefined,
    name: name || undefined,
    text: text || undefined,
    testid: testid || undefined,
  }
}

function fallbackCss(el: Element): string {
  const id = el.getAttribute('id')
  if (id) return `#${cssEscape(id)}`
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0]
  return cls ? `${tag}.${cssEscape(cls)}` : tag
}

function cssEscape(s: string): string {
  // CSS.escape isn't available off-DOM (tests); do a minimal escape of the common offenders.
  return s.replace(/([^\w-])/g, '\\$1')
}

// Accessible name, in roughly the order the accname algorithm resolves it. Kept small on purpose.
function accessibleName(el: Element): string | undefined {
  const aria = el.getAttribute('aria-label')
  if (aria?.trim()) return aria.trim()
  const alt = el.getAttribute('alt')
  if (alt?.trim()) return alt.trim()
  const ph = el.getAttribute('placeholder')
  if (ph?.trim()) return ph.trim()
  const title = el.getAttribute('title')
  if (title?.trim()) return title.trim()
  const val = (el as HTMLInputElement).value
  if ((el.tagName === 'INPUT' || el.tagName === 'BUTTON') && typeof val === 'string' && val.trim()) return val.trim()
  return undefined
}

function shortText(el: Element): string | undefined {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > 80 ? t.slice(0, 80) + '…' : t
}

// Minimal implicit-role map — enough for the elements testers actually click.
function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : undefined
    case 'button':
      return 'button'
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'input': {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['text', 'email', 'tel', 'url', 'search', 'password', 'number'].includes(type)) return 'textbox'
      return undefined
    }
    default:
      if (/^h[1-6]$/.test(tag)) return 'heading'
      return undefined
  }
}
