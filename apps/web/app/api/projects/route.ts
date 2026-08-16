import { NextResponse } from 'next/server'
import { repo, type Project } from '@th/db'
import { isAuthed } from '@/lib/auth'

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

/** Two boards whose names differ only by case or padding are one board to a human — matching that way is what
 *  makes this endpoint safe to run twice. */
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Create a board and hand back BOTH of its keys: `{ "name": "…" }` → `{ ok, created, project }`.
 *
 * Deliberately owner-cookie only, and deliberately NOT under the CORS block above: this is the one route in the
 * app that returns `readKey` and `ingestKey`, and until now those existed only inside a cookie-gated HTML page.
 * An ingest key must not be able to mint a board with fresh keys, so the extension's auth is not accepted here.
 * Sign in first with POST /api/session and send the th_auth cookie back.
 *
 * Idempotent by name, because the caller is a setup script that is expected to be re-run: an existing board is
 * returned as-is with `created: false` rather than silently duplicated under the same name — two boards with one
 * name is a trap the owner would only find later, when half the tickets are on the wrong one.
 */
export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json(
      {
        ok: false,
        error: 'unauthorized',
        message:
          'Creating a board mints its keys, so it is the owner\'s call: POST /api/session {"password": …} first and send the th_auth cookie back. An ingest or read key is not accepted here.',
      },
      { status: 401 },
    )
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json', message: 'Send a JSON body: {"name": "<board name>"}.' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json(
      { ok: false, error: 'name_required', message: 'Send "name": how the board is called on the dashboard, e.g. "erental".' },
      { status: 400 },
    )
  }

  const existing = repo.listProjects().find((p) => sameName(p.name, name))
  const project: Project = existing ?? repo.createProject(name)
  return NextResponse.json({
    ok: true,
    created: !existing,
    project: { id: project.id, name: project.name, readKey: project.readKey, ingestKey: project.ingestKey },
  })
}
