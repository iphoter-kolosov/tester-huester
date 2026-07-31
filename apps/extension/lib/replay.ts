import { record } from 'rrweb'
import { replayHealth, replaySpanSeconds } from '@th/core/replay-health'

// Continuous rrweb DOM-replay recorder with a circular buffer — we always hold roughly the last ~2 minutes
// so a captured report can carry a replayable reconstruction of the moments leading to the bug. Not a video:
// it's a compact DOM event stream (one capture, two consumers — a human watches, an agent reads the timeline).
// Privacy-first: maskAllInputs is ON, so field values never enter the recording.

export type RREvent = { type: number; timestamp: number; data?: unknown }

const CHECKOUT_MS = 60_000 // a fresh full snapshot every minute → clean trim boundaries
// Explicit clips:每 checkpoint is a whole new DOM snapshot, and a clip stitched from many of them replays
// badly (rrweb rebuilds the tree at each one; scrubbing across them can land on an empty frame). Two minutes
// keeps a typical repro to a SINGLE snapshot — playback fidelity beats fine-grained left-edge trimming.
const CLIP_CHECKPOINT_MS = 120_000
// The retrospective buffer is bounded by TIME, not by segment count: an idle tab produces few events, so
// four segments could span seven minutes and claim to be "the last 2 minutes".
const RETENTION_MS = 120_000
const MAX_SEGMENTS = 4 // bound memory: keep at most ~4 minutes retained
const KEEP_SEGMENTS = 3 // on capture, hand back ~2–3 minutes
const META = 4 // rrweb EventType.Meta
const FULL_SNAPSHOT = 2 // rrweb EventType.FullSnapshot

// Elements with this class are excluded from the recording — we tag our own overlay host with it.
export const REPLAY_BLOCK_CLASS = 'th-replay-block'

const RECORD_OPTS = {
  maskAllInputs: true,
  recordCanvas: false,
  collectFonts: false,
  sampling: { mousemove: 100, scroll: 150, media: 800, input: 'last' },
  blockClass: REPLAY_BLOCK_CLASS,
}

let matrix: RREvent[][] = [[]]
let stopFn: (() => void) | null = null
let lastError = '' // why the recorder isn't running, if it isn't — surfaced in the overlay and in the report

// Self-report of the recorder's actual state. Attached to reports so a capture that arrives without a replay
// explains ITSELF, instead of leaving us to guess from the absence of data.
export function recorderDiag(): Record<string, unknown> {
  const flat = matrix.flat()
  return {
    recording: !!stopFn,
    clipRecording: !!clipStopFn,
    bufferedEvents: flat.length,
    bufferedSeconds: Math.round(replaySpanSeconds(flat)),
    segments: matrix.length,
    clipEvents: clipEvents?.length ?? 0,
    lastError: lastError || null,
  }
}

export function startReplay(): void {
  if (stopFn) return
  try {
    const stop = record({
      emit(event: RREvent, isCheckout?: boolean) {
        // Start a new ring segment on the checkout's META only. rrweb flags BOTH the Meta and the FullSnapshot
        // of a checkout with isCheckout, so splitting on every flagged event would put them in different
        // segments — halving the retained window and, worse, letting the ring drop a segment BETWEEN a snapshot
        // and its own mutations (the clip then boots from a snapshot whose node ids the mutations don't match,
        // and rrweb silently discards them → a frozen replay). One checkout = one segment keeps every segment
        // self-contained: [Meta, FullSnapshot, ...incrementals].
        if (isCheckout && event.type === META) {
          matrix.push([])
          if (matrix.length > MAX_SEGMENTS) matrix.shift()
          // Drop whole segments that fell out of the retention window, so the buffer really is "the last
          // ~2 minutes" and not however long four idle segments happen to cover.
          while (matrix.length > 1) {
            const seg = matrix[0]!
            const last = seg[seg.length - 1]
            if (last && event.timestamp - last.timestamp > RETENTION_MS) matrix.shift()
            else break
          }
        }
        matrix[matrix.length - 1]!.push(event)
      },
      checkoutEveryNms: CHECKOUT_MS,
      ...RECORD_OPTS,
    } as Parameters<typeof record>[0])
    stopFn = (stop as (() => void) | undefined) ?? null
    if (!stopFn) lastError = 'rrweb record() returned no stop handle'
    else lastError = ''
  } catch (e) {
    // A hostile/complex page can break instrumentation — never let it break the extension, but never fail
    // silently either: this string is what tells us why a report came back with no replay.
    stopFn = null
    lastError = 'record() threw: ' + String((e as Error)?.message || e).slice(0, 200)
    console.warn('[th] replay recorder failed to start:', e)
  }
}

// Record only the tab the tester is actually looking at. A bug is reproduced in the foreground, so recording
// every background tab buys nothing and costs a MutationObserver + listeners in each of them. Hidden → stop,
// visible again → start fresh (a new snapshot, so the buffer stays self-consistent).
export function bindVisibility(doc: Document = document): void {
  const onVis = () => {
    if (isClipRecording()) return // an explicit recording owns the page; never interrupt it
    if (doc.visibilityState === 'hidden') stopReplay()
    else startReplay()
  }
  doc.addEventListener('visibilitychange', onVis)
  if (doc.visibilityState === 'hidden') stopReplay()
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

// ─────────────────────────── EXPLICIT repro recording ───────────────────────────
// A dedicated recorder, NOT a slice of the ring buffer. Slicing can only ever produce a clip that is as
// consistent as the buffer's segment boundaries; a fresh `record()` run emits its own FullSnapshot followed by
// an unbroken mutation stream, so the clip is self-contained by construction — the only way to guarantee that
// what the tester reproduced is exactly what plays back. The retrospective recorder is paused meanwhile
// (rrweb's mirror is process-wide; two concurrent recorders would fight over node ids) and resumed on stop.

let clipEvents: RREvent[] | null = null
let clipStopFn: (() => void) | null = null

export function isClipRecording(): boolean {
  return !!clipStopFn
}

// Seconds captured so far in the explicit clip (0 if not recording).
export function clipSeconds(): number {
  return clipEvents ? spanSeconds(clipEvents) : 0
}

export function startExplicitClip(): boolean {
  if (clipStopFn) return true
  stopReplay() // hand the page over to the dedicated recorder
  clipEvents = []
  try {
    const stop = record({
      emit(event: RREvent) {
        clipEvents!.push(event)
      },
      // Periodic checkpoints exist so the tester can TRIM the clip afterwards: a trim must start at a
      // Meta+FullSnapshot pair (otherwise the mutations have nothing to apply to), so checkpoints are the
      // possible left-hand cut points. 30s balances trim granularity against the size of an extra snapshot.
      checkoutEveryNms: CLIP_CHECKPOINT_MS,
      ...RECORD_OPTS,
    } as Parameters<typeof record>[0])
    clipStopFn = (stop as (() => void) | undefined) ?? null
    if (!clipStopFn) throw new Error('recorder did not start')
    lastError = ''
    return true
  } catch (e) {
    lastError = 'clip record() threw: ' + String((e as Error)?.message || e).slice(0, 200)
    console.warn('[th] explicit clip recorder failed to start:', e)
    clipEvents = null
    clipStopFn = null
    startReplay() // restore the retrospective buffer
    return false
  }
}

// Stop the explicit recording and return its events; the retrospective buffer resumes from a clean state.
export function stopExplicitClip(): RREvent[] {
  const events = clipEvents ?? []
  if (clipStopFn) {
    try {
      clipStopFn()
    } catch {}
  }
  clipStopFn = null
  clipEvents = null
  matrix = [[]] // the ring's old segments predate this recorder's mirror — never mix them with new events
  startReplay()
  return events
}

// ─────────────────────────── shared helpers ───────────────────────────

// Shared with the web player via @th/core so "healthy clip" has exactly one definition on both sides.
export const spanSeconds = replaySpanSeconds
export const clipHealth = replayHealth

// Offsets (seconds from the clip start) at which a trim can begin: every Meta+FullSnapshot pair. A clip must
// open on one — mutations address a DOM the player builds from that snapshot — so these are the only honest
// left-hand cut points, and the UI snaps the handle to them.
export function trimPoints(events: RREvent[]): number[] {
  if (events.length < 2) return [0]
  const t0 = events[0]!.timestamp
  const out: number[] = []
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i]!.type === META && events[i + 1]!.type === FULL_SNAPSHOT) out.push((events[i]!.timestamp - t0) / 1000)
  }
  return out.length ? out : [0]
}

// Cut a clip down to [fromSec, toSec]. The left edge snaps back to the latest checkpoint at or before fromSec
// (never forward — that would drop the snapshot the remaining mutations depend on); the right edge is exact,
// since dropping trailing events is always safe. Returns the events plus the range actually applied.
export function trimClip(events: RREvent[], fromSec: number, toSec: number): { events: RREvent[]; from: number; to: number } {
  if (events.length < 2) return { events, from: 0, to: 0 }
  const t0 = events[0]!.timestamp
  const total = replaySpanSeconds(events)
  const to = Math.min(Math.max(toSec, 0), total)

  let boot = 0
  let bootSec = 0
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i]!.type === META && events[i + 1]!.type === FULL_SNAPSHOT) {
      const at = (events[i]!.timestamp - t0) / 1000
      if (at <= fromSec + 0.001 && at <= to) {
        boot = i
        bootSec = at
      }
    }
  }
  const cutTs = t0 + to * 1000
  const out: RREvent[] = []
  for (let i = boot; i < events.length; i++) {
    if (events[i]!.timestamp > cutTs) break
    out.push(events[i]!)
  }
  return { events: out, from: bootSec, to }
}

// Pure + unit-tested: flatten the retained window and return a slice that BOOTS a Replayer — i.e. starting at
// a Meta immediately followed by a FullSnapshot. With one-segment-per-checkout every segment is self-contained,
// so anchoring to the OLDEST boot pair in the window yields the longest consistent clip.
export function sliceRecentEvents(m: RREvent[][]): RREvent[] {
  const flat = m.slice(-KEEP_SEGMENTS).flat()
  for (let i = 0; i < flat.length - 1; i++) {
    if (flat[i]!.type === META && flat[i + 1]!.type === FULL_SNAPSHOT) return flat.slice(i)
  }
  const f = flat.findIndex((e) => e.type === FULL_SNAPSHOT)
  return f >= 0 ? flat.slice(f) : [] // no full snapshot in window → not replayable
}
