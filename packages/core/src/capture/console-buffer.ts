import { Ring } from './ring.js'
import { capText, scrubTokens } from './redact.js'
import type { ConsoleEntry } from './types.js'

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
type Level = (typeof LEVELS)[number]

// Safe, bounded stringify of console arguments — never throws, never dumps a megabyte, scrubs tokens.
export function formatArgs(args: unknown[]): string {
  const parts = args.map((a) => formatOne(a))
  return capText(scrubTokens(parts.join(' ')), 2000)
}

function formatOne(a: unknown): string {
  if (a === null) return 'null'
  if (a === undefined) return 'undefined'
  const t = typeof a
  if (t === 'string') return a as string
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(a)
  if (a instanceof Error) return `${a.name}: ${a.message}`
  try {
    return JSON.stringify(a, safeReplacer())
  } catch {
    return Object.prototype.toString.call(a)
  }
}

function safeReplacer(): (k: string, v: unknown) => unknown {
  const seen = new WeakSet()
  return (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) return '[Circular]'
      seen.add(v as object)
    }
    if (typeof v === 'function') return '[Function]'
    return v
  }
}

export type Unpatch = () => void

// Tees console.{log,info,warn,error,debug} + uncaught errors + unhandled rejections into a ring, while
// leaving the real console untouched. MUST run in the page's MAIN world to see the app's own logs.
export function patchConsole(ring: Ring<ConsoleEntry>, target: Console = console, win?: Window & typeof globalThis, now: () => number = Date.now): Unpatch {
  const originals = new Map<Level, (...a: unknown[]) => void>()
  for (const level of LEVELS) {
    const orig = target[level] as (...a: unknown[]) => void
    originals.set(level, orig)
    target[level] = (...args: unknown[]) => {
      try {
        ring.push({ level, text: formatArgs(args), ts: now() })
      } catch {
        /* capturing must never break the app's console */
      }
      return orig.apply(target, args)
    }
  }
  const onError = (e: ErrorEvent) => ring.push({ level: 'error', text: capText(scrubTokens(`Uncaught ${e.message}${e.filename ? ` @ ${e.filename}:${e.lineno}` : ''}`), 2000), ts: now() })
  const onRejection = (e: PromiseRejectionEvent) => ring.push({ level: 'error', text: capText(scrubTokens(`Unhandled rejection: ${stringifyReason(e.reason)}`), 2000), ts: now() })
  win?.addEventListener?.('error', onError as EventListener)
  win?.addEventListener?.('unhandledrejection', onRejection as EventListener)
  return () => {
    for (const level of LEVELS) {
      const orig = originals.get(level)
      if (orig) target[level] = orig
    }
    win?.removeEventListener?.('error', onError as EventListener)
    win?.removeEventListener?.('unhandledrejection', onRejection as EventListener)
  }
}

function stringifyReason(r: unknown): string {
  if (r instanceof Error) return `${r.name}: ${r.message}`
  return formatArgs([r])
}
