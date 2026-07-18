import fs from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { ASSET_DIR } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Serves runtime-written blobs (screenshots, replay JSON) from the data dir. This is what makes uploads work
// in production — `public/` won't serve files written after build. Name is strictly validated to block any
// path traversal; only a bare `<uuid>.<ext>` is accepted.
const SAFE = /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|json)$/
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  json: 'application/json',
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  if (!SAFE.test(name)) return new NextResponse('bad name', { status: 400 })
  const ext = name.split('.').pop()!.toLowerCase()
  const file = path.join(ASSET_DIR, name)
  // Defence in depth: ensure the resolved path stays inside ASSET_DIR.
  if (path.relative(ASSET_DIR, file).startsWith('..')) return new NextResponse('bad name', { status: 400 })
  let buf: Buffer
  try {
    buf = await fs.readFile(file)
  } catch {
    return new NextResponse('not found', { status: 404 })
  }
  // A Node Buffer / typed array isn't accepted as BodyInit by the type checker; a Blob is.
  const type = TYPES[ext] || 'application/octet-stream'
  return new NextResponse(new Blob([new Uint8Array(buf)], { type }), {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' },
  })
}
