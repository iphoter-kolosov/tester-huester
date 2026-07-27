// Is an rrweb event list actually PLAYABLE, or would it freeze on the first frame?
//
// rrweb resolves every mutation against the mirror it builds from the clip's FullSnapshot and SILENTLY DROPS
// the ones it cannot resolve. A clip stitched together from mismatched moments (e.g. sliced across a ring
// buffer boundary) therefore renders as a still image with a moving cursor — the recording *looks* fine in the
// dashboard and is useless to both the human and the agent. This check makes that failure visible: the
// extension refuses to attach such a clip, and the player labels an already-stored one instead of pretending.
//
// Framework-agnostic and dependency-free so the extension (before sending) and the web player (after loading)
// share exactly one definition of "healthy".

export type ReplayEvent = { type: number; timestamp: number; data?: unknown }

const META = 4
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3

// A few unresolved refs are normal (a node removed and then referenced again); a majority means the snapshot
// and the mutations come from different points in time.
const MAX_MISSING_RATIO = 0.25

export type ReplayHealth = {
  playable: boolean
  reason: 'ok' | 'empty' | 'no_boot_frame' | 'mutations_unresolved'
  resolved: number
  missing: number
}

type SnapNode = { id?: number; childNodes?: SnapNode[] }

export function replayHealth(events: ReplayEvent[]): ReplayHealth {
  if (!events || events.length < 2) return { playable: false, reason: 'empty', resolved: 0, missing: 0 }
  if (!(events[0]!.type === META && events[1]!.type === FULL_SNAPSHOT)) {
    return { playable: false, reason: 'no_boot_frame', resolved: 0, missing: 0 }
  }

  const known = new Set<number>()
  const walk = (n: SnapNode | undefined) => {
    if (!n) return
    if (typeof n.id === 'number') known.add(n.id)
    for (const c of n.childNodes ?? []) walk(c)
  }
  walk((events[1]!.data as { node?: SnapNode })?.node)

  let resolved = 0
  let missing = 0
  const count = (id: number | undefined) => {
    if (id == null || id < 0) return
    if (known.has(id)) resolved++
    else missing++
  }
  for (const e of events) {
    if (e.type !== INCREMENTAL) continue
    const d = (e.data ?? {}) as {
      attributes?: { id?: number }[]
      texts?: { id?: number }[]
      removes?: { id?: number }[]
      adds?: { parentId?: number; node?: SnapNode }[]
    }
    // Walk in rrweb's own apply order — removes, then adds (each add makes its subtree addressable for
    // everything after it), then texts, then attributes. Checking refs before folding in that batch's adds
    // reports healthy clips as broken: a React re-render adds thousands of nodes and immediately addresses
    // them, so the parentIds legitimately resolve only once the earlier adds have been applied.
    for (const r of d.removes ?? []) count(r.id)
    for (const a of d.adds ?? []) {
      count(a.parentId)
      walk(a.node)
    }
    for (const t of d.texts ?? []) count(t.id)
    for (const a of d.attributes ?? []) count(a.id)
  }

  const total = resolved + missing
  const playable = total === 0 || missing / total < MAX_MISSING_RATIO
  return { playable, reason: playable ? 'ok' : 'mutations_unresolved', resolved, missing }
}

export function replaySpanSeconds(events: ReplayEvent[]): number {
  if (!events || events.length < 2) return 0
  const ts = events.map((e) => e.timestamp).filter(Boolean)
  return ts.length ? (Math.max(...ts) - Math.min(...ts)) / 1000 : 0
}
