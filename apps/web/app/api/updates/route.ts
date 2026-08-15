import { NextResponse } from 'next/server'
import { repo, normalizeIdentity, UPDATE_FILTERS, type ChangeEvent, type UpdateFilter } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'
import { participantsOf } from '@/lib/roster'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_WAIT_S = 55 // stay under typical proxy idle timeouts
const POLL_MS = 700

/**
 * Parse `?filter=inbox,review,rework`. Unknown names are an ERROR, not something to ignore: a filter the server
 * silently drops turns an agent's narrow question into "give me everything", and it would never find out.
 */
function parseFilters(raw: string | null): { filters: UpdateFilter[] } | { bad: string[] } {
  if (!raw) return { filters: [] }
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const bad = wanted.filter((f) => !(UPDATE_FILTERS as readonly string[]).includes(f))
  if (bad.length) return { bad }
  return { filters: [...new Set(wanted)] as UpdateFilter[] }
}

// What changed in this project since a cursor — the alternative to an agent re-reading every ticket to notice
// a reply. Three modes:
//   • immediate:  GET /api/updates?projectKey=…            → events since the SERVER-side cursor
//   • long-poll:  GET /api/updates?projectKey=…&wait=30    → holds the request until something happens (or the
//                 wait elapses), so the agent reacts within a second of a change instead of on a timer.
//   • addressed:  GET /api/updates?projectKey=…&agent=me&filter=inbox,review,rework
//                 → only the events that concern THAT agent: tasks addressed to it, tickets it filed that are
//                   now waiting for its review, and tickets sent back to it as rejected.
// The cursor only advances on an explicit ack (POST), so an agent that dies mid-work resumes without loss.
export async function GET(req: Request) {
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error
  const url = new URL(req.url)
  const project = r.project

  // Read the identity BEFORE the cursor: on a board several agents share, each of them keeps its own position,
  // and taking the project-wide one here would hand this agent a starting point another agent had already moved.
  const agent = normalizeIdentity(url.searchParams.get('agent'))
  const sinceParam = url.searchParams.get('since')
  const since = sinceParam != null && sinceParam !== '' ? Number(sinceParam) : repo.getCursor(project.id, agent)
  if (!Number.isFinite(since) || since < 0) {
    return NextResponse.json({ ok: false, error: 'bad_since' }, { status: 400 })
  }
  const limit = Math.min(Number(url.searchParams.get('limit') || 100) || 100, 500)
  const waitS = Math.min(Math.max(Number(url.searchParams.get('wait') || 0) || 0, 0), MAX_WAIT_S)

  const parsed = parseFilters(url.searchParams.get('filter'))
  if ('bad' in parsed) {
    return NextResponse.json(
      { ok: false, error: 'bad_filter', message: `Unknown filter(s): ${parsed.bad.join(', ')}. Use any comma-separated subset of: ${UPDATE_FILTERS.join(', ')} — or omit "filter" for the whole project.` },
      { status: 400 },
    )
  }
  if (parsed.filters.length && !agent) {
    return NextResponse.json(
      { ok: false, error: 'agent_required', message: 'A filtered read is relative to somebody: pass "agent" with the identity you act under (the same string you send as "agent" on a status change).' },
      { status: 400 },
    )
  }

  // Unfiltered: the whole project, exactly as before. Filtered: only this agent's events, plus how far the
  // journal was actually examined — acking THAT is what makes a narrow read safe (see repo.eventsSinceFor).
  const read = (): { events: ChangeEvent[]; ackTo: number } => {
    if (!parsed.filters.length) {
      const events = repo.eventsSince(project.id, since, limit)
      return { events, ackTo: events.length ? events[events.length - 1]!.seq : since }
    }
    const { events, scannedTo } = repo.eventsSinceFor(project.id, since, agent!, parsed.filters, limit)
    return { events, ackTo: scannedTo }
  }

  let out = read()

  if (!out.events.length && waitS > 0) {
    const deadline = Date.now() + waitS * 1000
    while (Date.now() < deadline) {
      if (req.signal.aborted) break // the agent hung up — stop burning a connection
      await new Promise((res) => setTimeout(res, POLL_MS))
      out = read()
      if (out.events.length) break
    }
  }

  // Who the `actor` on each event is. Without it the journal reads as a list of bare handles — the state that made
  // the owner ask for roles in the first place.
  const participants = participantsOf(out.events.map((e) => e.actor))
  return NextResponse.json({
    ok: true,
    project: project.name,
    since,
    cursor: out.ackTo, // pass back on ack (POST) once the work is done
    latest: repo.latestSeq(project.id),
    agent,
    filter: parsed.filters,
    count: out.events.length,
    events: out.events,
    agents: participants.agents,
    unknownParticipants: participants.unknown,
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
  // Ack under the same identity the read was made under, or the agent advances a position it is not the one
  // reading from. The query string is accepted too, so the ack looks like the GET it belongs to.
  const agent = normalizeIdentity(body.agent) ?? normalizeIdentity(new URL(req.url).searchParams.get('agent'))
  // An ack is the cheapest honest liveness signal there is: the agent named itself and moved its own position, so
  // it is running right now. There is no fallback here — an unnamed ack moves the shared project cursor and says
  // nothing about who did it, so it registers nobody.
  if (agent) repo.touchAgent(agent, r.project.id)
  return NextResponse.json({ ok: true, agent, cursor: repo.setCursor(r.project.id, seq, agent) })
}
