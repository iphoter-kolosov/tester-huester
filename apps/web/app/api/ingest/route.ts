import { NextResponse } from 'next/server'
import { repo, type ReportType, type Severity } from '@th/db'
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

  const note = clip(body.note, 5000) || ''
  if (!note && !screenshotUrl) {
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

  // Record what the SERVER actually received, next to what the extension reported sending. When a replay goes
  // missing, these two halves together say whether it was never sent, arrived broken, or failed to store.
  const context = sanitizeContext(body.context)
  if (context && context.diag && typeof context.diag === 'object') {
    Object.assign(context.diag as Record<string, unknown>, {
      received: replayEvents ? replayEvents.length : 0,
      compressed: typeof body.replayGz === 'string' ? body.replayGz.length : 0,
      stored: !!replayUrl,
    })
  }

  const row = repo.createReport({
    projectId: targetProjectId,
    note,
    screenshotUrl,
    pageUrl: clip(body.pageUrl, 2000),
    viewport: clip(body.viewport, 40),
    userAgent: clip(body.userAgent, 500),
    reporter: clip(body.reporter, 200),
    context,
    replayUrl,
    type: asType(body.type),
    severity: asSeverity(body.severity),
  })

  return NextResponse.json({ ok: true, id: row.id }, { headers: CORS })
}
