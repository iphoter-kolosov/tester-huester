import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const STATUSES = ['new', 'triaged', 'fixed', 'wontfix']

// Agent-facing read: one report as JSON, scoped by ?projectKey=<read_key>. 404 if it isn't this project's.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const r = resolveProjectKey(req)
  if ('error' in r) return r.error
  const report = repo.getReport(id)
  if (!report || report.projectId !== r.project.id) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, report })
}

// Human-facing write: status triage. Gated by the dashboard cookie (open in dev when DASH_PASSWORD is unset).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }
  const status = String(body.status || '')
  if (!STATUSES.includes(status)) {
    return NextResponse.json({ ok: false, error: 'bad_status' }, { status: 400 })
  }
  const ok = repo.setStatus(id, status)
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
}
