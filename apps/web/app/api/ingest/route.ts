import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { storage } from '@/lib/storage'

export const runtime = 'nodejs'

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
  }
  try {
    if (JSON.stringify(out).length > 512_000) return null
  } catch {
    return null
  }
  const hasSignal = out.env || (out.console as unknown[]).length || (out.network as unknown[]).length || (out.actions as unknown[]).length
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

  const row = repo.createReport({
    projectId: proj.id,
    note,
    screenshotUrl,
    pageUrl: clip(body.pageUrl, 2000),
    viewport: clip(body.viewport, 40),
    userAgent: clip(body.userAgent, 500),
    reporter: clip(body.reporter, 200),
    context: sanitizeContext(body.context),
  })

  return NextResponse.json({ ok: true, id: row.id }, { headers: CORS })
}
