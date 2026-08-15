import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'
import { participantsOf } from '@/lib/roster'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Agent-facing read-API: list this project's reports as JSON. Auth = ?projectKey=<read_key> (NOT the
// dashboard cookie). Supports &type= &status= &limit=. Strictly scoped to the resolved project.
export async function GET(req: Request) {
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error

  const url = new URL(req.url)
  const type = url.searchParams.get('type') || undefined
  const status = url.searchParams.get('status') || undefined
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined

  const reports = repo.listReports({ projectId: r.project.id, type, status, limit })
  // Who the handles on these tickets are, in the same answer: a list of `creator`/`assignee` strings with nobody
  // behind them is what made addressing impossible in the first place.
  const participants = participantsOf(reports.flatMap((x) => [x.creator, x.assignee, x.takenBy]))
  return NextResponse.json({
    ok: true,
    project: { id: r.project.id, name: r.project.name },
    count: reports.length,
    reports,
    agents: participants.agents,
    unknownParticipants: participants.unknown,
  })
}
