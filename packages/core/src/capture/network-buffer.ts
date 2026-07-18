import { Ring } from './ring.js'
import { redactUrl } from './redact.js'
import type { NetworkEntry } from './types.js'

export type Unwrap = () => void

// Wraps fetch + XMLHttpRequest to record method/url/status/timing. MUST run in MAIN world to see the
// app's own requests. Deliberately does NOT read response bodies (cost, privacy) — status+timing is what
// triages a bug. Blind spots (Service Worker, sendBeacon, WebSocket) are documented; a chrome.debugger
// "deep mode" can fill them later.
export function wrapFetchXhr(ring: Ring<NetworkEntry>, win: (Window & typeof globalThis) | (typeof globalThis) = globalThis, now: () => number = Date.now): Unwrap {
  const w = win as unknown as { fetch?: typeof fetch; XMLHttpRequest?: typeof XMLHttpRequest }
  const origFetch = w.fetch
  const OrigXHR = w.XMLHttpRequest

  if (typeof origFetch === 'function') {
    w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const start = now()
      const method = (init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET') || 'GET').toUpperCase()
      const url = urlOf(input)
      return origFetch.apply(this, [input as RequestInfo, init] as Parameters<typeof fetch>).then(
        (res: Response) => {
          push(ring, { method, url: redactUrl(url), status: res.status, ms: Math.round(now() - start), kind: 'fetch', ts: start })
          return res
        },
        (err: unknown) => {
          push(ring, { method, url: redactUrl(url), status: 0, ms: Math.round(now() - start), kind: 'fetch', error: errText(err), ts: start })
          throw err
        },
      )
    } as typeof fetch
  }

  if (typeof OrigXHR === 'function') {
    const Wrapped = function (this: XMLHttpRequest) {
      const xhr = new OrigXHR()
      let method = 'GET'
      let url = ''
      let start = 0
      const origOpen = xhr.open
      xhr.open = function (m: string, u: string | URL, ...rest: unknown[]): void {
        method = (m || 'GET').toUpperCase()
        url = String(u)
        // @ts-expect-error variadic passthrough
        return origOpen.call(xhr, m, u, ...rest)
      }
      const origSend = xhr.send
      xhr.send = function (...args: unknown[]): void {
        start = now()
        xhr.addEventListener('loadend', () => {
          const failed = xhr.status === 0
          push(ring, { method, url: redactUrl(url), status: xhr.status, ms: Math.round(now() - start), kind: 'xhr', error: failed ? 'network error / aborted' : undefined, ts: start })
        })
        // @ts-expect-error variadic passthrough
        return origSend.apply(xhr, args)
      }
      return xhr
    } as unknown as typeof XMLHttpRequest
    Wrapped.prototype = OrigXHR.prototype
    w.XMLHttpRequest = Wrapped
  }

  return () => {
    if (origFetch) w.fetch = origFetch
    if (OrigXHR) w.XMLHttpRequest = OrigXHR
  }
}

function push(ring: Ring<NetworkEntry>, e: NetworkEntry): void {
  try {
    ring.push(e)
  } catch {
    /* capture must never break the app's networking */
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (typeof input === 'object' && input && 'url' in input) return (input as Request).url
  return String(input)
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
