import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { collectorBase } from '@/lib/collector'

export const dynamic = 'force-dynamic'

// The newest extension build this board hands out. The extension is installed unpacked (no Web Store, so no
// automatic updates): it asks here when the overlay or popup opens and, if it is behind, offers the download in
// one click. Public on purpose — a version number and a zip of public code, nothing about any project.
// Written by scripts/release-extension.sh together with the zip it points at.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

type Latest = { version: string; file: string; notes: string[]; releasedAt: string }

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: Request) {
  let latest: Latest
  try {
    latest = JSON.parse(await readFile(path.join(process.cwd(), 'public', 'extension', 'latest.json'), 'utf8')) as Latest
  } catch (e) {
    console.error('[api/extension] latest.json unreadable', e)
    return NextResponse.json({ ok: false, error: 'no_release' }, { status: 404, headers: CORS })
  }
  // Not new URL(req.url).origin: behind the proxy that is the loopback the process listens on (lib/collector.ts).
  const origin = collectorBase(req.headers)
  return NextResponse.json(
    { ok: true, version: latest.version, url: `${origin}/extension/${latest.file}`, notes: latest.notes, releasedAt: latest.releasedAt },
    { headers: { ...CORS, 'Cache-Control': 'no-store' } },
  )
}
