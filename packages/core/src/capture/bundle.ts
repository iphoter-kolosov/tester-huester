import type { Ring } from './ring.js'
import type { ConsoleEntry, NetworkEntry, ActionStep, EnvInfo, ReproBundle } from './types.js'

// Re-exported so Node consumers (MCP) can pull the pure repro helpers + types WITHOUT loading the
// annotator / @medv/finder (which the main '.' entry pulls in). Import from '@th/core/repro'.
export type { ReproBundle, ConsoleEntry, NetworkEntry, ActionStep, EnvInfo, SelectorCandidates } from './types.js'

// Caps so one long-lived tab can't produce a multi-megabyte payload. The rings are already bounded; this
// is the final belt-and-suspenders trim at assembly time.
export const CAPS = { console: 100, network: 100, actions: 60 } as const

export type BundleSources = {
  env: EnvInfo
  console?: Ring<ConsoleEntry> | ConsoleEntry[]
  network?: Ring<NetworkEntry> | NetworkEntry[]
  actions?: Ring<ActionStep> | ActionStep[]
  now?: () => number
}

export function assembleBundle(src: BundleSources): ReproBundle {
  const now = src.now ?? Date.now
  return {
    env: src.env,
    console: lastN(toArr(src.console), CAPS.console),
    network: lastN(toArr(src.network), CAPS.network),
    actions: lastN(toArr(src.actions), CAPS.actions),
    capturedAt: now(),
  }
}

function toArr<T>(x: Ring<T> | T[] | undefined): T[] {
  if (!x) return []
  return Array.isArray(x) ? x : x.all()
}

function lastN<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(arr.length - n) : arr
}

// Human-readable numbered repro steps from the action trail — the same text an agent gets over MCP.
export function reproSteps(bundle: ReproBundle): string[] {
  return bundle.actions.map((a, i) => `${i + 1}. ${describeStep(a)}`)
}

function describeStep(a: ActionStep): string {
  const target = a.selector.name || a.selector.text || a.selector.testid || a.selector.css
  const via = a.selector.role ? `${a.selector.role} "${target}"` : `"${target}"`
  switch (a.type) {
    case 'click':
      return `Click ${via}`
    case 'input':
    case 'change':
      return `Type ${a.value ? `"${a.value}"` : ''} into ${via}`.replace(/\s+/g, ' ').trim()
    case 'submit':
      return `Submit ${via}`
    case 'key':
      return `Press ${a.key} on ${via}`
    default:
      return `${a.type} ${via}`
  }
}
