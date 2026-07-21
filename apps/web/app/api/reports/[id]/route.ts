import { NextResponse } from 'next/server'
import { repo, type ReportType, type Severity } from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const STATUSES = ['new', 'triaged', 'fixed', 'wontfix']
const TYPES = ['feature', 'bug', 'fix', 'text']
const SEVERITIES = ['low', 'med', 'high', 'crit']

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

// Write endpoint with two authorized callers:
//   • Agent  — `?projectKey=<read_key>` may set `status` ONLY on a report that belongs to that project. This
//     is the scoped write a dev agent uses to mark its own cases fixed/wontfix as it works through them.
//   • Human  — the dashboard cookie may set `status` and/or move the report to another project (`projectId`).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const projectKey = new URL(req.url).searchParams.get('projectKey') || ''

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }

  // Agent path: scoped status write, authorized by the project read key.
  if (projectKey) {
    const project = repo.getProjectByReadKey(projectKey)
    if (!project) {
      return NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 })
    }
    const status = String(body.status || '')
    if (!STATUSES.includes(status)) {
      return NextResponse.json({ ok: false, error: 'bad_status' }, { status: 400 })
    }
    const report = repo.getReport(id)
    if (!report || report.projectId !== project.id) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    }
    const ok = repo.setStatus(id, status)
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
  }

  // Human path: dashboard cookie. Full property editing — status, project, type, severity, note, archived.
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  let touched = false
  if ('status' in body) {
    const status = String(body.status || '')
    if (!STATUSES.includes(status)) return NextResponse.json({ ok: false, error: 'bad_status' }, { status: 400 })
    if (!repo.setStatus(id, status)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    touched = true
  }
  if ('projectId' in body) {
    const pid = String(body.projectId || '')
    if (!repo.getProjectById(pid)) return NextResponse.json({ ok: false, error: 'bad_project' }, { status: 400 })
    if (!repo.moveReport(id, pid)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    touched = true
  }
  if ('type' in body) {
    const type = String(body.type || '')
    if (!TYPES.includes(type)) return NextResponse.json({ ok: false, error: 'bad_type' }, { status: 400 })
    if (!repo.updateReport(id, { type: type as ReportType })) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    touched = true
  }
  if ('severity' in body) {
    const sev = String(body.severity || '')
    if (!SEVERITIES.includes(sev)) return NextResponse.json({ ok: false, error: 'bad_severity' }, { status: 400 })
    if (!repo.updateReport(id, { severity: sev as Severity })) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    touched = true
  }
  if ('note' in body) {
    const note = String(body.note ?? '').slice(0, 5000)
    if (!repo.updateReport(id, { note })) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    touched = true
  }
  if ('archived' in body) {
    if (!repo.setArchived(id, !!body.archived)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    touched = true
  }
  if (!touched) {
    return NextResponse.json({ ok: false, error: 'nothing_to_update' }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}

// Hard delete — dashboard cookie only, and only for a report that is already archived (archive-then-delete is
// the two-stage safety, so nothing is destroyed straight off the active board).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const r = repo.getReport(id)
  if (!r) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (!r.archived) return NextResponse.json({ ok: false, error: 'archive_first' }, { status: 409 })
  const ok = repo.deleteReport(id)
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
}
