import { Ring } from './ring.js'
import { bestSelector } from './selector.js'
import { maskInputValue } from './redact.js'
import type { ActionStep } from './types.js'

// Records what the tester DID — the "hands". This is the same trail an agent would replay: each step is
// an action + a robust multi-candidate selector + (masked) value. Capture-phase listeners so we still
// see the event even if the app calls stopPropagation.
export type ActionEventLike = {
  type: string
  target: EventTarget | null
  key?: string
}

const KEYS_OF_INTEREST = new Set(['Enter', 'Escape', 'Tab'])

// Pure: one DOM-ish event → zero or one step. Exported for unit testing without a live document.
export function toStep(ev: ActionEventLike, url: string, now: () => number = Date.now): ActionStep | null {
  const el = ev.target as Element | null
  if (!el || typeof (el as Element).tagName !== 'string') return null
  const base = { selector: bestSelector(el), url, ts: now() }
  switch (ev.type) {
    case 'click':
      return { type: 'click', ...base }
    case 'input':
    case 'change': {
      const value = maskInputValue(el, String((el as HTMLInputElement).value ?? ''))
      return { type: ev.type === 'input' ? 'input' : 'change', value, ...base }
    }
    case 'submit':
      return { type: 'submit', ...base }
    case 'keydown':
      if (ev.key && KEYS_OF_INTEREST.has(ev.key)) return { type: 'key', key: ev.key, ...base }
      return null
    default:
      return null
  }
}

export class ActionRecorder {
  private handlers: Array<[string, EventListener]> = []
  // input events fire per keystroke; keep only the last per target so the trail is "final value", not noise.
  private lastInputAt = new WeakMap<Element, number>()

  constructor(
    private ring: Ring<ActionStep>,
    private doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    if (!this.doc) return
    const on = (type: string, fn: EventListener) => {
      this.doc!.addEventListener(type, fn, { capture: true, passive: true })
      this.handlers.push([type, fn])
    }
    on('click', (e) => this.record(e as unknown as ActionEventLike))
    on('change', (e) => this.record(e as unknown as ActionEventLike))
    on('submit', (e) => this.record(e as unknown as ActionEventLike))
    on('keydown', (e) => this.record({ type: 'keydown', target: (e as KeyboardEvent).target, key: (e as KeyboardEvent).key }))
    // coalesce inputs: record on 'change'/blur rather than every 'input', but keep a debounced last value
    on('input', (e) => {
      const el = (e as Event).target as Element | null
      if (el) this.lastInputAt.set(el, this.now())
    })
  }

  private record(ev: ActionEventLike): void {
    try {
      const step = toStep(ev, this.doc?.location?.href ?? '', this.now)
      if (step) this.ring.push(step)
    } catch {
      /* capture must never break the page */
    }
  }

  stop(): void {
    if (!this.doc) return
    for (const [type, fn] of this.handlers) this.doc.removeEventListener(type, fn, { capture: true } as EventListenerOptions)
    this.handlers = []
  }
}
