import { NextResponse } from 'next/server'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { ASSET_DIR, ASSET_BASE } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Streamed video upload. MV3 message passing caps a single sendMessage at 64 MiB, so we cannot marshal a whole
// tab recording through it — the extension POSTs the raw webm here directly (Chrome's chrome-extension:// origin
// is allowed by the CORS header below) and gets an ephemeral URL back. The report ingest then just references
// that URL by videoUrl. Two-step so the recording never has to live in a data URL.
//
// A per-chunk POST is unnecessary for our size: Node's request body streams to disk (25 MB limit is generous
// with vp8/9 at UI bitrates), and we set body-parser to allow the size we need.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-key',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// 40 MB max — plenty for 3 minutes of vp8 UI capture at ~1.5 Mbps; anything larger is a smell (unfocused
// dashboards or someone recording a video player) and would blow the ticket size anyway.
const MAX_BYTES = 40 * 1024 * 1024

export async function POST(req: Request) {
  const ct = req.headers.get('content-type') || ''
  if (!ct.startsWith('video/')) return NextResponse.json({ ok: false, error: 'bad_type' }, { status: 400, headers: CORS })
  const ab = await req.arrayBuffer().catch(() => null)
  if (!ab) return NextResponse.json({ ok: false, error: 'no_body' }, { status: 400, headers: CORS })
  if (ab.byteLength > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large', maxBytes: MAX_BYTES }, { status: 413, headers: CORS })
  if (ab.byteLength < 512) return NextResponse.json({ ok: false, error: 'empty' }, { status: 400, headers: CORS })

  const ext = ct.includes('mp4') ? 'mp4' : 'webm'
  const name = `${crypto.randomUUID()}.${ext}`
  await fs.mkdir(ASSET_DIR, { recursive: true })
  await fs.writeFile(path.join(ASSET_DIR, name), Buffer.from(ab))
  return NextResponse.json({ ok: true, url: `${ASSET_BASE}/${name}`, bytes: ab.byteLength }, { headers: CORS })
}
