import { NextResponse } from 'next/server'
import { repo, normalizeIdentity } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The collector side of session tracking, for the REMOTE MCP shim (apps/mcp/src/remote.ts). The shim has no
 * database of its own, so it cannot do what the local server does directly against the agent_sessions table:
 * register the running process and read back who else is live under the same handle. This endpoint does both in
 * one call — the exact contract the shim's registerSession() speaks (POST {session, agent, origin, startedAt} →
 * {sessions}) — and it is what makes collision detection real for the agents that actually have the problem:
 * eRENTAL's worktrees all connect through the deployed collector over HTTPS, not a shared DB file. Without this
 * route the shim degrades to "keep TH_AGENT distinct by hand" and the dashboard's collision view stays empty
 * because no remote fork ever records a session.
 *
 * Auth is the project READ key (?projectKey=…): announcing liveness is a read-level act, the same key every other
 * agent read uses, and the shim already attaches it. The handle is global, so the live set returned spans every
 * worktree signing as it — which is the whole point of the answer.
 */
export async function POST(req: Request) {
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }

  // Every field is validated before the row is opened, so a malformed announce is refused loudly rather than
  // writing a session nobody can make sense of. openSession would throw on a bad agent/id; catching those here
  // turns them into a 400 the caller can read instead of a 500 it cannot.
  const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'missing_session', message: 'Send "session": the process\'s session id.' }, { status: 400 })
  }
  const agent = normalizeIdentity(body.agent)
  if (!agent) {
    return NextResponse.json({ ok: false, error: 'missing_agent', message: 'Send "agent": the handle this session signs as.' }, { status: 400 })
  }
  const startedAt = typeof body.startedAt === 'number' && Number.isFinite(body.startedAt) ? body.startedAt : null
  if (startedAt === null) {
    return NextResponse.json({ ok: false, error: 'bad_started_at', message: 'Send "startedAt": the epoch-ms this session began.' }, { status: 400 })
  }
  const origin = typeof body.origin === 'string' ? body.origin : ''

  // Upsert the fork's row (last_seen moves to now) and hand back the live set for this handle — one process per
  // row, so more than one is the collision the shim's whoami turns into a warning.
  repo.openSession({ sessionId, agent, projectId: r.project.id, origin, startedAt })
  return NextResponse.json({ ok: true, sessions: repo.liveSessions(agent) })
}
