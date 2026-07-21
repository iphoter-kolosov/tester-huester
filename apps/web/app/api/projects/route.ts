import { NextResponse } from 'next/server'
import { repo } from '@th/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Lets the extension overlay show a "send to which project" picker. Gated by a valid ingest key (the extension
// already holds one) — single-tenant, so any valid ingest key may list the account's projects. Returns id+name
// only (never the keys). CORS-open because the extension calls it from a content-script/background on any origin.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-key',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export function GET(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('ingestKey') || req.headers.get('x-ingest-key') || ''
  const own = key ? repo.getProjectByKey(key) : null
  if (!own) {
    return NextResponse.json({ ok: false, error: 'bad_key' }, { status: 401, headers: CORS })
  }
  // id+name only — never the keys. `defaultId` = the project this ingest key belongs to, so the overlay can
  // preselect it. The overlay sends the chosen id back as `projectId` on ingest.
  const projects = repo.listProjects().map((p) => ({ id: p.id, name: p.name }))
  return NextResponse.json({ ok: true, projects, defaultId: own.id }, { headers: CORS })
}
