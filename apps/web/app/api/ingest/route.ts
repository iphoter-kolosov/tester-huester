import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { repo, MAX_ATTACHMENTS, normalizeIdentity, IDENTITY_EXTENSION, type Attachment, type ReportType, type Severity } from '@th/db'
import { storage } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Note taxonomy contract (shared with the extension payload). Unknown/absent values fall back to defaults so
// older extension builds that don't send these fields keep working.
const TYPES: ReportType[] = ['feature', 'bug', 'fix', 'text']
const SEVERITIES: Severity[] = ['low', 'med', 'high', 'crit']
const asType = (v: unknown): ReportType => (typeof v === 'string' && (TYPES as string[]).includes(v) ? (v as ReportType) : 'bug')
const asSeverity = (v: unknown): Severity => (typeof v === 'string' && (SEVERITIES as string[]).includes(v) ? (v as Severity) : 'med')

// The extension posts from a content script running on ANY origin, so this endpoint is CORS-open and
// answers the preflight. Auth is the project's ingest key, not the origin.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-key',
}
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null)

// An attachment may arrive already uploaded (POST /api/upload/image, same two-step as video) — in that case we
// get a URL instead of bytes. Pin it to the exact shape our own asset route mints so a caller cannot smuggle an
// arbitrary URL into a ticket that humans and agents will click.
const ASSET_IMAGE_URL = /^\/api\/asset\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/
const ATTACHMENT_CAPTION_MAX = 2000
// The cap counts entries we actually STORED, so a couple of malformed ones don't silently cost the reporter
// slots. This bounds how far we look for those 10 — without it a hostile body could make us walk an arbitrarily
// long array of junk.
const ATTACHMENT_SCAN_MAX = 40

// `attachments` is the "ten tickets in one" payload: each entry is a picture with its markup already baked in
// plus its own caption. Two accepted forms per entry, both optionally captioned:
//   { image: 'data:image/…', caption? }  — bytes inline (small shots, the overlay path)
//   { url: '/api/asset/….png', caption? } — already uploaded via /api/upload/image
// Order is preserved; entries we cannot store are dropped rather than aborting the whole report.
async function storeAttachments(v: unknown): Promise<Attachment[]> {
  if (!Array.isArray(v) || !v.length) return []
  const out: Attachment[] = []
  for (const raw of v.slice(0, ATTACHMENT_SCAN_MAX)) {
    if (out.length >= MAX_ATTACHMENTS) break
    if (!raw || typeof raw !== 'object') continue
    const a = raw as { image?: unknown; url?: unknown; caption?: unknown }
    const caption = typeof a.caption === 'string' ? a.caption.slice(0, ATTACHMENT_CAPTION_MAX) : ''
    let url: string | null = null
    if (typeof a.image === 'string' && a.image.startsWith('data:image/')) {
      try {
        url = await storage.put(a.image)
      } catch (e) {
        console.warn('ingest: attachment store failed:', e)
      }
    } else if (typeof a.url === 'string' && ASSET_IMAGE_URL.test(a.url)) {
      url = a.url
    }
    if (url) out.push({ id: crypto.randomUUID(), url, caption, at: Date.now() })
  }
  return out
}

// Never trust the client: keep only known keys and re-cap the arrays server-side (defence in depth on top
// of the extension's own caps). Drop the whole bundle if it serialises to something implausibly large.
function sanitizeContext(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const c = v as Record<string, unknown>
  const arr = (x: unknown, n: number) => (Array.isArray(x) ? x.slice(-n) : [])
  const out: Record<string, unknown> = {
    env: c.env && typeof c.env === 'object' ? c.env : undefined,
    console: arr(c.console, 200),
    network: arr(c.network, 200),
    actions: arr(c.actions, 100),
    capturedAt: typeof c.capturedAt === 'number' ? c.capturedAt : undefined,
    // The extension's recorder self-report. Kept even when everything else is empty: a report that arrives
    // without a replay must still be able to say why.
    diag: c.diag && typeof c.diag === 'object' && !Array.isArray(c.diag) ? c.diag : undefined,
  }
  try {
    if (JSON.stringify(out).length > 512_000) return null
  } catch {
    return null
  }
  const hasSignal = out.env || out.diag || (out.console as unknown[]).length || (out.network as unknown[]).length || (out.actions as unknown[]).length
  return hasSignal ? out : null
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400, headers: CORS })
  }

  const key = String(body.ingestKey || req.headers.get('x-ingest-key') || '')
  if (!key) return NextResponse.json({ ok: false, error: 'no_key' }, { status: 401, headers: CORS })
  const proj = repo.getProjectByKey(key)
  if (!proj) return NextResponse.json({ ok: false, error: 'bad_key' }, { status: 401, headers: CORS })
  // Optional routing override: the overlay's project picker sends `projectId`. A valid ingest key may deposit
  // into any of the account's projects (single-tenant); an unknown id falls back to the key's own project.
  let targetProjectId = proj.id
  if (typeof body.projectId === 'string' && body.projectId) {
    const target = repo.getProjectById(body.projectId)
    if (target) targetProjectId = target.id
  }

  let screenshotUrl: string | null = null
  const shot = body.screenshot
  if (typeof shot === 'string' && shot.startsWith('data:image/')) {
    try {
      screenshotUrl = await storage.put(shot)
    } catch (e) {
      console.warn('ingest: screenshot store failed:', e)
    }
  }

  // Extra annotated images, each with its own caption. Additional to `screenshot`, never a replacement for it —
  // the quick overlay path still sends only `screenshot` and must behave exactly as before.
  const attachments = await storeAttachments(body.attachments)

  const note = clip(body.note, 5000) || ''
  if (!note && !screenshotUrl && !attachments.length) {
    return NextResponse.json({ ok: false, error: 'empty' }, { status: 400, headers: CORS })
  }

  // The rrweb replay is large → store it as its own blob and keep only a URL on the report. The extension
  // sends it gzip+base64 (`replayGz`) because a minute of a dense UI is several MB uncompressed; `replay`
  // (plain array) stays supported for older builds and for browsers without CompressionStream.
  let replayUrl: string | null = null
  let replayEvents: unknown[] | null = null
  if (typeof body.replayGz === 'string' && body.replayGz.length > 0) {
    try {
      const { gunzipSync } = await import('node:zlib')
      const parsed = JSON.parse(gunzipSync(Buffer.from(body.replayGz, 'base64')).toString('utf8'))
      if (Array.isArray(parsed)) replayEvents = parsed
    } catch (e) {
      console.warn('ingest: replay decompress failed:', e)
    }
  } else if (Array.isArray(body.replay)) {
    replayEvents = body.replay
  }
  if (replayEvents && replayEvents.length > 1) {
    // `trim` is the stretch the tester selected in the editor. The clip physically starts at the checkpoint
    // at/before that point (a clip must open on a snapshot), so the player uses this to show exactly what was
    // chosen — no lead-in the tester already decided to cut.
    const t = body.replayTrim as { from?: unknown; to?: unknown } | undefined
    const trim =
      t && typeof t.from === 'number' && typeof t.to === 'number' && t.to > t.from
        ? { from: Math.max(0, t.from), to: t.to }
        : undefined
    try {
      replayUrl = await storage.putJson(trim ? { events: replayEvents, trim } : { events: replayEvents })
    } catch (e) {
      console.warn('ingest: replay store failed:', e)
    }
  }

  // The tab recording — an actual video of what the tester saw. Stored as-is (already codec-compressed).
  let videoUrl: string | null = null
  const videoSeconds = typeof body.videoSeconds === 'number' ? Math.round(body.videoSeconds) : null
  const vt = body.videoTrim as { from?: unknown; to?: unknown } | undefined
  const videoTrim =
    vt && typeof vt.from === 'number' && typeof vt.to === 'number' && vt.to > vt.from
      ? { from: Math.max(0, vt.from), to: vt.to }
      : null
  if (typeof body.video === 'string' && body.video.startsWith('data:video/')) {
    try {
      videoUrl = await storage.putVideo(body.video)
    } catch (e) {
      console.warn('ingest: video store failed:', e)
    }
  }
  // Preferred path: the extension already uploaded the video via /api/upload/video and gives us the URL. Keep
  // the string to a safe /api/asset/<file>.(webm|mp4) shape so an attacker can't smuggle an arbitrary URL.
  if (!videoUrl && typeof body.videoUrl === 'string' && /^\/api\/asset\/[a-zA-Z0-9_-]+\.(webm|mp4)$/.test(body.videoUrl)) {
    videoUrl = body.videoUrl
  }

  // Stills sampled from the recording. Stored as ordinary images so an agent can LOOK at them — it cannot
  // watch a webm, and a video nobody on the fixing side can open is a dead end.
  let videoFrames: { at: number; url: string }[] | null = null
  if (Array.isArray(body.videoFrames) && body.videoFrames.length) {
    const out: { at: number; url: string }[] = []
    for (const f of (body.videoFrames as { at?: unknown; dataUrl?: unknown }[]).slice(0, 12)) {
      if (typeof f?.dataUrl !== 'string' || !f.dataUrl.startsWith('data:image/')) continue
      try {
        out.push({ at: typeof f.at === 'number' ? Math.round(f.at * 10) / 10 : 0, url: await storage.put(f.dataUrl) })
      } catch (e) {
        console.warn('ingest: frame store failed:', e)
      }
    }
    if (out.length) videoFrames = out
  }

  // Record what the SERVER actually received, next to what the extension reported sending. When a replay goes
  // missing, these two halves together say whether it was never sent, arrived broken, or failed to store.
  const context = sanitizeContext(body.context)
  if (context && context.diag && typeof context.diag === 'object') {
    Object.assign(context.diag as Record<string, unknown>, {
      received: replayEvents ? replayEvents.length : 0,
      compressed: typeof body.replayGz === 'string' ? body.replayGz.length : 0,
      stored: !!replayUrl,
      video: !!videoUrl,
      videoSeconds,
      videoFrames: videoFrames?.length ?? 0,
      attachments: attachments.length,
    })
  }

  // WHO filed this, as a structured identity, and who it is FOR. An agent filing a ticket for another agent
  // declares both; the extension declares neither, and a capture with no declared filer is the extension's own —
  // which is the truth, and is what the journal records instead of the flat "extension" it used to claim for
  // every row regardless of origin.
  const creator = normalizeIdentity(body.creator) ?? IDENTITY_EXTENSION
  const assignee = normalizeIdentity(body.assignee)

  const row = repo.createReport({
    projectId: targetProjectId,
    note,
    creator,
    assignee,
    screenshotUrl,
    pageUrl: clip(body.pageUrl, 2000),
    viewport: clip(body.viewport, 40),
    userAgent: clip(body.userAgent, 500),
    reporter: clip(body.reporter, 200),
    context,
    replayUrl,
    videoUrl,
    videoSeconds,
    videoTrim,
    videoFrames,
    attachments,
    type: asType(body.type),
    severity: asSeverity(body.severity),
  })

  repo.logEvent({ projectId: targetProjectId, reportId: row.id, kind: 'created', actor: creator, detail: (note || '(без заметки)').slice(0, 120) })
  return NextResponse.json({ ok: true, id: row.id, creator, assignee, attachments: row.attachments.length }, { headers: CORS })
}
