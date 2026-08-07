// Work in progress, persisted. The site under test is usually a dev server that reloads the page after every
// save; when it does, the content script is torn down and re-injected, and everything the tester had drawn,
// typed and recorded used to die with it. This store is the single owner of that work.
//
// chrome.storage.local (NOT storage.session) on purpose: a draft must outlive a browser restart, not just a
// navigation. One draft per ORIGIN, so capturing a bug on two sites at once does not have them overwrite
// each other.
import type { ReportType, Severity } from './report'

export const DRAFT_VERSION = 1
export const DRAFT_KEY_PREFIX = 'th.draft.'
// A day. Long enough to survive lunch, a crash and an overnight; short enough that a draft you have forgotten
// about never ambushes you weeks later with a screenshot of a page that no longer exists.
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000
// A base screenshot is 1–3 MB, and stills sampled from a video add more. Keep a small, bounded number of
// origins rather than letting the store grow until a write fails.
export const MAX_DRAFTS = 3
// Typing must not hit storage on every keystroke; a reload that beats this window still loses nothing,
// because loadDraft reads through the pending buffer and the overlay flushes on pagehide.
export const SAVE_DEBOUNCE_MS = 400

export type DraftShot = { dataUrl: string }
// An extra image the tester added in the standalone editor window: a pasted screenshot, a dropped file, a
// second frame of the same bug. Each carries its OWN markup, so switching between them in the editor is
// lossless; `base` is the backdrop alone, exactly like `shot` above and for the same reason (a crop replaces
// the backdrop). `caption` is the "Опишите, что здесь" line that ships to the collector next to the image.
export type DraftAttachment = { id: string; base: string; prims: unknown[]; caption: string }
export type DraftVideo = {
  url: string
  seconds: number
  bytes: number
  capped?: boolean
  frames: { at: number; dataUrl: string }[]
}

export type Draft = {
  version: number
  origin: string
  pageUrl: string
  updatedAt: number
  // Was the overlay on screen when the page died? Drives automatic re-opening after a reload.
  open: boolean
  note: string
  type: ReportType
  severity: Severity
  projectId: string | null
  // The backdrop WITHOUT markup — markup lives in `prims` so both can be restored independently (a crop
  // replaces the backdrop; re-loading the original screenshot would silently undo it).
  shot: DraftShot | null
  prims: unknown[]
  // Additional images, in the order the reporter numbered them. Empty for a capture made in the page overlay,
  // which only ever has the one screenshot.
  attachments: DraftAttachment[]
  video: DraftVideo | null
  context: unknown | null
}

export function draftKey(origin: string): string {
  return DRAFT_KEY_PREFIX + origin
}

function blank(origin: string): Draft {
  return {
    version: DRAFT_VERSION,
    origin,
    pageUrl: '',
    updatedAt: 0,
    open: false,
    note: '',
    type: 'bug',
    severity: 'med',
    projectId: null,
    shot: null,
    prims: [],
    attachments: [],
    video: null,
    context: null,
  }
}

// A stored value is only usable if it is this exact schema version: silently mixing shapes across versions
// would restore half a report and look like data loss with extra steps.
function parse(v: unknown): Draft | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Partial<Draft>
  if (d.version !== DRAFT_VERSION) return null
  if (typeof d.updatedAt !== 'number' || !Number.isFinite(d.updatedAt)) return null
  if (typeof d.origin !== 'string') return null
  return { ...blank(d.origin), ...(d as Draft) }
}

const expired = (d: Draft, now: number): boolean => now - d.updatedAt > DRAFT_TTL_MS

// Is there anything a human would be upset to lose? A screenshot alone does not count — the overlay takes a
// fresh one every time it opens, so announcing "draft restored" for that would be noise. An ATTACHMENT does
// count: nobody pastes an image by accident. Optional-chained because a record written by an older build of
// this same schema version has no `attachments` key at all until it is read through parse().
export function hasContent(d: Draft | null): boolean {
  if (!d) return false
  return !!(d.note.trim() || d.prims.length || d.video || d.attachments?.length)
}

const area = () => chrome.storage.local

// ── the debounce buffer ──────────────────────────────────────────────────────────────────────────────────
// Patches accumulate here and are written as one batch. Reads go through it, so the overlay can never read
// back text it just typed.
const pending = new Map<string, Partial<Draft>>()
let timer: ReturnType<typeof setTimeout> | null = null
let waiters: { resolve: () => void; reject: (e: unknown) => void }[] = []

// Shallow-merge a patch into this origin's draft. The returned promise settles when the value is actually in
// storage — a rejection means the work is NOT saved and the caller must say so out loud.
export function saveDraft(origin: string, patch: Partial<Draft>): Promise<void> {
  pending.set(origin, { ...(pending.get(origin) ?? {}), ...patch })
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { void flushDrafts() }, SAVE_DEBOUNCE_MS)
  return new Promise<void>((resolve, reject) => { waiters.push({ resolve, reject }) })
}

// Write everything buffered right now. Called on every meaningful change (a finished primitive, a taken
// screenshot, a finished video) and on pagehide, where the debounce would be a race against the teardown.
export async function flushDrafts(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  const batch = [...pending.entries()]
  pending.clear()
  const settle = waiters
  waiters = []
  try {
    if (batch.length) await writeBatch(batch)
    for (const w of settle) w.resolve()
  } catch (e) {
    // Surfaced through each saveDraft promise; flushDrafts itself stays quiet so a fire-and-forget flush
    // cannot turn a storage hiccup into an unhandled rejection.
    for (const w of settle) w.reject(e)
  }
}

async function writeBatch(batch: [string, Partial<Draft>][]): Promise<void> {
  const now = Date.now()
  const existing = await area().get(batch.map(([o]) => draftKey(o)))
  const items: Record<string, Draft> = {}
  for (const [origin, patch] of batch) {
    const key = draftKey(origin)
    const base = parse(existing[key]) ?? blank(origin)
    items[key] = { ...base, ...patch, version: DRAFT_VERSION, origin, updatedAt: now }
  }
  await area().set(items)
  await evict(new Set(Object.keys(items)))
}

// Keep the store bounded: sweep expired drafts, then drop the oldest until at most MAX_DRAFTS remain. The
// drafts just written are never candidates — evicting the thing you are working on would be absurd.
async function evict(keep: Set<string>): Promise<void> {
  const all = await area().get(null)
  const now = Date.now()
  const live: { key: string; updatedAt: number }[] = []
  const doomed: string[] = []
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(DRAFT_KEY_PREFIX)) continue
    const d = parse(value)
    if (!d || expired(d, now)) { doomed.push(key); continue }
    live.push({ key, updatedAt: d.updatedAt })
  }
  live.sort((a, b) => b.updatedAt - a.updatedAt)
  for (const row of live.slice(MAX_DRAFTS)) if (!keep.has(row.key)) doomed.push(row.key)
  if (doomed.length) await area().remove(doomed)
}

// Read this origin's draft. A record that is expired or written by another schema version is not returned and
// is deleted on the spot, so it cannot resurface later.
export async function loadDraft(origin: string): Promise<Draft | null> {
  const key = draftKey(origin)
  const got = await area().get(key)
  const stored = parse(got[key])
  const patch = pending.get(origin)
  if (!stored || expired(stored, Date.now())) {
    if (got[key] !== undefined) await area().remove(key)
    return patch ? { ...blank(origin), ...patch, updatedAt: Date.now() } : null
  }
  return patch ? { ...stored, ...patch } : stored
}

// Every live draft, newest first. Sweeps expired ones as it goes; non-draft keys in the same storage area
// (the collector URL, the ingest key) are never touched.
export async function listDrafts(): Promise<Draft[]> {
  const all = await area().get(null)
  const now = Date.now()
  const out: Draft[] = []
  const doomed: string[] = []
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(DRAFT_KEY_PREFIX)) continue
    const d = parse(value)
    if (!d || expired(d, now)) { doomed.push(key); continue }
    out.push(d)
  }
  if (doomed.length) await area().remove(doomed)
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

// Forget this origin's work — on a successful send, on "Начать заново", on Cancel. Drops the buffered patch
// too, otherwise a write already scheduled would resurrect the draft a few hundred milliseconds later.
export async function clearDraft(origin: string): Promise<void> {
  pending.delete(origin)
  await area().remove(draftKey(origin))
}
