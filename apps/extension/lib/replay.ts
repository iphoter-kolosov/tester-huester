import { record } from 'rrweb'

// Continuous rrweb DOM-replay recorder with a circular buffer — we always hold roughly the last ~2 minutes
// so a captured report can carry a replayable reconstruction of the moments leading to the bug. Not a video:
// it's a compact DOM event stream (one capture, two consumers — a human watches, an agent reads the timeline).
// Privacy-first: maskAllInputs is ON, so field values never enter the recording.

export type RREvent = { type: number; timestamp: number; data?: unknown }

const CHECKOUT_MS = 60_000 // a fresh full snapshot every minute → clean trim boundaries
const MAX_SEGMENTS = 4 // bound memory: keep at most ~4 minutes retained
const KEEP_SEGMENTS = 3 // on capture, hand back ~2–3 minutes
const META = 4 // rrweb EventType.Meta
const FULL_SNAPSHOT = 2 // rrweb EventType.FullSnapshot

// Elements with this class are excluded from the recording — we tag our own overlay host with it.
export const REPLAY_BLOCK_CLASS = 'th-replay-block'

let matrix: RREvent[][] = [[]]
let stopFn: (() => void) | null = null

export function startReplay(): void {
  if (stopFn) return
  try {
    const stop = record({
      emit(event: RREvent, isCheckout?: boolean) {
        if (isCheckout) {
          matrix.push([])
          if (matrix.length > MAX_SEGMENTS) matrix.shift()
        }
        matrix[matrix.length - 1]!.push(event)
      },
      checkoutEveryNms: CHECKOUT_MS,
      maskAllInputs: true,
      recordCanvas: false,
      collectFonts: false,
      sampling: { mousemove: 100, scroll: 150, media: 800, input: 'last' },
      blockClass: REPLAY_BLOCK_CLASS,
    } as Parameters<typeof record>[0])
    stopFn = (stop as (() => void) | undefined) ?? null
  } catch {
    stopFn = null // a hostile page can break instrumentation — never let it break the extension
  }
}

export function stopReplay(): void {
  if (stopFn) {
    try {
      stopFn()
    } catch {}
    stopFn = null
  }
}

export function isRecording(): boolean {
  return !!stopFn
}

export function snapshotReplay(): RREvent[] {
  return sliceRecentEvents(matrix)
}

// Pure + unit-tested: flatten the retained window and return a slice that BOOTS a Replayer — i.e. starting at
// a Meta immediately followed by a FullSnapshot. rrweb emits Meta then FullSnapshot on every checkout, so the
// segment split can leave a segment headed by a bare FullSnapshot; we re-anchor to the Meta/FullSnapshot pair.
export function sliceRecentEvents(m: RREvent[][]): RREvent[] {
  const flat = m.slice(-KEEP_SEGMENTS).flat()
  for (let i = 0; i < flat.length - 1; i++) {
    if (flat[i]!.type === META && flat[i + 1]!.type === FULL_SNAPSHOT) return flat.slice(i)
  }
  const f = flat.findIndex((e) => e.type === FULL_SNAPSHOT)
  return f >= 0 ? flat.slice(f) : [] // no full snapshot in window → not replayable
}
