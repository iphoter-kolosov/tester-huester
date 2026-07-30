import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_WAIT_S = 55 // stay under typical proxy idle timeouts
const POLL_MS = 700

// What changed in this project since a cursor — the alternative to an agent re-reading every ticket to notice
// a reply. Two modes:
//   • immediate:  GET /api/updates?projectKey=…            → events since the SERVER-side cursor
//   • long-poll:  GET /api/updates?projectKey=…&wait=30    → holds the request until something happens (or the
//                 wait elapses), so the agent reacts within a second of a change instead of on a timer.
// The cursor only advances on an explicit ack (POST), so an agent that dies mid-work resumes without loss.
export async function GET(req: Request) {
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error
  const url = new URL(req.url)
  const project = r.project

  const sinceParam = url.searchParams.get('since')
  const since = sinceParam != null && sinceParam !== '' ? Number(sinceParam) : repo.getCursor(project.id)
  if (!Number.isFinite(since) || since < 0) {
    return NextResponse.json({ ok: false, error: 'bad_since' }, { status: 400 })
  }
  const limit = Math.min(Number(url.searchParams.get('limit') || 100) || 100, 500)
  const waitS = Math.min(Math.max(Number(url.searchParams.get('wait') || 0) || 0, 0), MAX_WAIT_S)

  let events = repo.eventsSince(project.id, since, limit)

  if (!events.length && waitS > 0) {
    const deadline = Date.now() + waitS * 1000
    while (Date.now() < deadline) {
      if (req.signal.aborted) break // the agent hung up — stop burning a connection
      await new Promise((res) => setTimeout(res, POLL_MS))
      events = repo.eventsSince(project.id, since, limit)
      if (events.length) break
    }
  }

  const cursor = events.length ? events[events.length - 1]!.seq : since
  return NextResponse.json({
    ok: true,
    project: project.name,
    since,
    cursor, // pass back on ack (POST) once the work is done
    latest: repo.latestSeq(project.id),
    count: events.length,
    events,
  })
}

// Acknowledge: move the project's cursor forward once the agent has actually handled those events.
export async function POST(req: Request) {
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }
  const seq = Number(body.cursor)
  if (!Number.isFinite(seq) || seq < 0) return NextResponse.json({ ok: false, error: 'bad_cursor' }, { status: 400 })
  return NextResponse.json({ ok: true, cursor: repo.setCursor(r.project.id, seq) })
}
