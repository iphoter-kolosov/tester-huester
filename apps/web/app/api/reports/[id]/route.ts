import { NextResponse } from 'next/server'
import { repo, checkAgentStatusClaim, type ReportType, type Severity } from '@th/db'
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
  const report = repo.resolveReport(id)
  if (!report || report.projectId !== r.project.id) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  // Comments ride along so an agent picking the ticket up sees the whole conversation — its own earlier notes
  // and the human's replies — without a second call.
  return NextResponse.json({ ok: true, report, comments: repo.listComments(report.id) })
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
    const report = repo.resolveReport(id)
    if (!report || report.projectId !== project.id) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    }
    // A closing status must arrive WITH its evidence — see lib/verify.ts. Validated before anything is written,
    // so a rejected claim leaves the ticket exactly as it was.
    const claim = checkAgentStatusClaim(status, body, report.pageUrl)
    if (!claim.ok) return NextResponse.json({ ok: false, ...claim.err }, { status: 400 })

    const ok = repo.setStatus(report.id, status)
    if (!ok) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    repo.logEvent({ projectId: report.projectId, reportId: report.id, kind: 'status', actor: project.name, detail: `${report.status} → ${status}` })
    // The comment carries the claim, so the thread reads as a record: what changed, where to look, how to check.
    let comment = null
    if (claim.claim) {
      comment = repo.addComment({
        reportId: report.id,
        author: project.name,
        authorKind: 'agent',
        body: claim.claim.body,
        verifyUrl: claim.claim.verifyUrl,
        verifySteps: claim.claim.verifySteps,
      })
      repo.logEvent({ projectId: report.projectId, reportId: report.id, kind: 'comment', actor: project.name, detail: claim.claim.body.slice(0, 200) })
    }
    return NextResponse.json({ ok: true, status, comment })
  }

  // Human path: dashboard cookie. Full property editing — status, project, type, severity, note, archived.
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const before = repo.resolveReport(id)
  if (!before) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  // Every human edit is journalled, so the agent watching this project sees it on its next (cheap) poll —
  // including which project the ticket moved to, since that changes who owns it.
  const log = (kind: 'status' | 'edited' | 'archived' | 'moved', detail: string, projectId = before.projectId) =>
    repo.logEvent({ projectId, reportId: before.id, kind, actor: 'human', detail })

  let touched = false
  if ('status' in body) {
    const status = String(body.status || '')
    if (!STATUSES.includes(status)) return NextResponse.json({ ok: false, error: 'bad_status' }, { status: 400 })
    if (!repo.setStatus(before.id, status)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('status', `${before.status} → ${status}`)
    touched = true
  }
  if ('projectId' in body) {
    const pid = String(body.projectId || '')
    if (!repo.getProjectById(pid)) return NextResponse.json({ ok: false, error: 'bad_project' }, { status: 400 })
    if (!repo.moveReport(before.id, pid)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('moved', 'ticket moved out of this project')
    if (pid !== before.projectId) log('moved', 'ticket moved into this project', pid)
    touched = true
  }
  if ('type' in body) {
    const type = String(body.type || '')
    if (!TYPES.includes(type)) return NextResponse.json({ ok: false, error: 'bad_type' }, { status: 400 })
    if (!repo.updateReport(before.id, { type: type as ReportType })) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('edited', `type: ${before.type} → ${type}`)
    touched = true
  }
  if ('severity' in body) {
    const sev = String(body.severity || '')
    if (!SEVERITIES.includes(sev)) return NextResponse.json({ ok: false, error: 'bad_severity' }, { status: 400 })
    if (!repo.updateReport(before.id, { severity: sev as Severity })) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('edited', `severity: ${before.severity ?? '—'} → ${sev}`)
    touched = true
  }
  if ('note' in body) {
    const note = String(body.note ?? '').slice(0, 5000)
    if (!repo.updateReport(before.id, { note })) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('edited', `note edited: ${note.slice(0, 120)}`)
    touched = true
  }
  if ('archived' in body) {
    if (!repo.setArchived(before.id, !!body.archived)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('archived', body.archived ? 'archived' : 'restored from archive')
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
  const r = repo.resolveReport(id)
  if (!r) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (!r.archived) return NextResponse.json({ ok: false, error: 'archive_first' }, { status: 409 })
  const ok = repo.deleteReport(r.id)
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
}
