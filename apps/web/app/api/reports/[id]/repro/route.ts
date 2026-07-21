import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'
import { buildRepro } from '@/lib/repro'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Agent-facing read: an agent-ready reproduction (numbered steps + triage summary) for one report, scoped by
// ?projectKey=<read_key>. Shares buildRepro() with the MCP get_repro_steps tool so the two never drift.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error
  const report = repo.getReport(id)
  if (!report || report.projectId !== r.project.id) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, repro: buildRepro(report) })
}
