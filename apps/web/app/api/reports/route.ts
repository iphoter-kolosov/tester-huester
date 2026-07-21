import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'

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
  return NextResponse.json({
    ok: true,
    project: { id: r.project.id, name: r.project.name },
    count: reports.length,
    reports,
  })
}
