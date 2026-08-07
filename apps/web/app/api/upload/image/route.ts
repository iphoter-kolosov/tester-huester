import { NextResponse } from 'next/server'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { ASSET_DIR, ASSET_BASE } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Two-step image upload, the same shape as /api/upload/video and for the same reason: a capture carrying ten
// full-window screenshots would ride into /api/ingest as ten base64 data URLs — a JSON body several times the
// size of the pixels themselves, and one the extension would first have to hold in memory. Instead each image
// is POSTed here as raw bytes and only its URL travels in the ingest payload
// (`attachments: [{ url, caption }]`).
//
// CORS-open because the caller is a content script / offscreen document on an arbitrary origin; the write is
// harmless on its own (an orphan blob), and the report it belongs to is still gated by the ingest key.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-key',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// 12 MB — matches the per-image cap the dashboard's own annotator upload uses. A full 4K PNG screenshot is
// ~6 MB; anything past this is not a UI screenshot.
const MAX_BYTES = 12 * 1024 * 1024
// Below this there are no pixels, only a truncated or failed encode — say so instead of storing a stub.
const MIN_BYTES = 128
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
}

export async function POST(req: Request) {
  const ct = (req.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
  const ext = EXT_BY_TYPE[ct]
  if (!ext) return NextResponse.json({ ok: false, error: 'bad_type', accepted: Object.keys(EXT_BY_TYPE) }, { status: 400, headers: CORS })
  const ab = await req.arrayBuffer().catch(() => null)
  if (!ab) return NextResponse.json({ ok: false, error: 'no_body' }, { status: 400, headers: CORS })
  if (ab.byteLength > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large', maxBytes: MAX_BYTES }, { status: 413, headers: CORS })
  if (ab.byteLength < MIN_BYTES) return NextResponse.json({ ok: false, error: 'empty' }, { status: 400, headers: CORS })

  const name = `${crypto.randomUUID()}.${ext}`
  await fs.mkdir(ASSET_DIR, { recursive: true })
  await fs.writeFile(path.join(ASSET_DIR, name), Buffer.from(ab))
  return NextResponse.json({ ok: true, url: `${ASSET_BASE}/${name}`, bytes: ab.byteLength }, { headers: CORS })
}
