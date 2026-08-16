import { NextResponse } from 'next/server'
import {
  repo,
  checkAssignee,
  checkHandover,
  checkStatusTransition,
  normalizeIdentity,
  resolveSpeaker,
  IDENTITY_OWNER,
  type Actor,
  type EventKind,
  type ReportType,
  type Severity,
  type Speaker,
} from '@th/db'
import { resolveProjectKey } from '@/lib/projectKey'
import { isAuthed } from '@/lib/auth'
import { participantsOf } from '@/lib/roster'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const TYPES = ['feature', 'bug', 'fix', 'text']
const SEVERITIES = ['low', 'med', 'high', 'crit']
// The dashboard's own label for the human in the comment thread.
const OWNER_DISPLAY_NAME = 'Вы'

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
  const comments = repo.listComments(report.id)
  // The same for the voices in that conversation: who filed it, who holds it, and who each author on the thread
  // is. Only agent authors are looked up — a human comment carries a display name, not an identity.
  const participants = participantsOf([
    report.creator,
    report.assignee,
    report.takenBy,
    ...comments.filter((c) => c.authorKind === 'agent').map((c) => c.author),
  ])
  return NextResponse.json({
    ok: true,
    report,
    comments,
    agents: participants.agents,
    unknownParticipants: participants.unknown,
  })
}

/**
 * Who an agent request is FROM. The read key proves which board it may touch; `agent` says which of the agents
 * working that board is speaking. Old clients send no `agent` at all, so the project name stands in — which is
 * exactly the identity those clients have always been shown under in the journal and the comment thread. What
 * changes with the roster is only that an inferred name is never REGISTERED as an agent: see resolveSpeaker.
 */
function agentSpeaker(body: Record<string, unknown>, projectName: string, projectId: string): Speaker {
  return resolveSpeaker(body.agent, normalizeIdentity(projectName) ?? projectId)
}

// Write endpoint with two authorized callers:
//   • Agent  — `?projectKey=<read_key>` may set `status` and `assignee` ONLY on a report that belongs to that
//     project. What it may set the status TO depends on who it says it is: an executor can go no further than
//     `needs_review`; only the agent that FILED the ticket may accept or reject the work (see checkStatusTransition).
//   • Human  — the dashboard cookie may set anything, including moving the report to another project.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const projectKey = new URL(req.url).searchParams.get('projectKey') || ''

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }

  // Agent path: scoped write, authorized by the project read key.
  if (projectKey) {
    const project = repo.getProjectByReadKey(projectKey)
    if (!project) {
      return NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 })
    }
    const report = repo.resolveReport(id)
    if (!report || report.projectId !== project.id) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    }
    const speaker = agentSpeaker(body, project.name, project.id)
    const actor: Actor = { kind: 'agent', identity: speaker.identity }
    // Registered BEFORE the request is judged, and before the assignee is checked against the roster. An agent
    // that declared a name has acted, whatever the verdict on the write turns out to be — and doing it first is
    // what lets an agent hand a ticket to itself on its very first call.
    if (speaker.rosterHandle) repo.touchAgent(speaker.rosterHandle, project.id)

    const hasStatus = 'status' in body
    const hasAssignee = 'assignee' in body
    if (!hasStatus && !hasAssignee) {
      return NextResponse.json(
        { ok: false, error: 'nothing_to_update', message: 'Send "status" (the lifecycle move) and/or "assignee" (hand the ticket to another agent).' },
        { status: 400 },
      )
    }

    let assignee: string | null = null
    if (hasAssignee) {
      // One read of the roster answers both questions it is asked here: is there such an agent to receive this,
      // and is the one handing it over an agent this board can look up.
      const roster = repo.listAgents()
      const addressed = checkAssignee(body.assignee, roster)
      if (!addressed.ok) return NextResponse.json({ ok: false, ...addressed.err }, { status: 400 })
      assignee = addressed.assignee
      const handover = checkHandover(actor.identity, assignee, roster)
      if (!handover.ok) return NextResponse.json({ ok: false, ...handover.err }, { status: 400 })
    }

    // Validated in full before anything is written, so a refused request leaves the ticket exactly as it was.
    const decision = hasStatus
      ? checkStatusTransition(
          String(body.status ?? ''),
          body,
          { status: report.status, creator: report.creator, takenBy: report.takenBy, pageUrl: report.pageUrl },
          actor,
        )
      : null
    if (decision && !decision.ok) return NextResponse.json({ ok: false, ...decision.err }, { status: 400 })

    if (hasAssignee) {
      if (!repo.setAssignee(report.id, assignee)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
      repo.logEvent({
        projectId: report.projectId,
        reportId: report.id,
        kind: 'assigned',
        actor: actor.identity,
        detail: assignee ? `assignee: ${report.assignee ?? '—'} → ${assignee}` : `assignee cleared (was ${report.assignee ?? '—'})`,
      })
    }

    let comment = null
    if (decision && decision.ok) {
      if (!repo.setStatus(report.id, decision.status)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
      if (decision.takenBy) repo.setTaken(report.id, decision.takenBy)
      repo.logEvent({ projectId: report.projectId, reportId: report.id, kind: 'status', actor: actor.identity, detail: `${report.status} → ${decision.status}` })
      // The comment carries the work report, so the thread reads as a record: what changed, where to look, how to
      // check it, and what proves it.
      if (decision.claim) {
        comment = repo.addComment({
          reportId: report.id,
          author: actor.identity,
          authorKind: 'agent',
          body: decision.claim.body,
          verifyUrl: decision.claim.verifyUrl,
          verifySteps: decision.claim.verifySteps,
          evidence: decision.claim.evidence,
        })
        repo.logEvent({ projectId: report.projectId, reportId: report.id, kind: 'comment', actor: actor.identity, detail: decision.claim.body.slice(0, 200) })
      }
    }
    return NextResponse.json({
      ok: true,
      status: decision && decision.ok ? decision.status : report.status,
      assignee: hasAssignee ? assignee : report.assignee,
      takenBy: decision && decision.ok && decision.takenBy ? decision.takenBy : report.takenBy,
      agent: actor.identity,
      comment,
    })
  }

  // Human path: dashboard cookie. Full property editing — status, project, type, severity, note, assignee, archived.
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const before = repo.resolveReport(id)
  if (!before) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  const owner: Actor = { kind: 'owner', identity: IDENTITY_OWNER }
  // The owner is a participant with a roster row like any other, so his activity is recorded like any other. His
  // identity is not self-declared but PROVEN by the dashboard cookie, which is why it needs no resolveSpeaker.
  repo.touchAgent(IDENTITY_OWNER, before.projectId)
  // Every human edit is journalled, so the agent watching this project sees it on its next (cheap) poll —
  // including which project the ticket moved to, since that changes who owns it.
  const log = (kind: EventKind, detail: string, projectId = before.projectId) =>
    repo.logEvent({ projectId, reportId: before.id, kind, actor: IDENTITY_OWNER, detail })

  let touched = false
  if ('status' in body) {
    const decision = checkStatusTransition(
      String(body.status ?? ''),
      body,
      { status: before.status, creator: before.creator, takenBy: before.takenBy, pageUrl: before.pageUrl },
      owner,
    )
    if (!decision.ok) return NextResponse.json({ ok: false, ...decision.err }, { status: 400 })
    if (!repo.setStatus(before.id, decision.status)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('status', `${before.status} → ${decision.status}`)
    // The owner's verdict reaches the executor as a message, not just a word on a card — this is the whole
    // instruction behind a rejection.
    if (decision.claim) {
      repo.addComment({
        reportId: before.id,
        author: OWNER_DISPLAY_NAME,
        authorKind: 'human',
        body: decision.claim.body,
        verifyUrl: decision.claim.verifyUrl,
        verifySteps: decision.claim.verifySteps,
        evidence: decision.claim.evidence,
      })
      log('comment', decision.claim.body.slice(0, 200))
    }
    touched = true
  }
  if ('assignee' in body) {
    // The roster check applies to the owner too: a ticket he addresses to a handle nobody answers to is just as
    // invisible as one an agent misaddresses, and the error hands him the list of who is actually there. The
    // ROLE gate does not: it exists so an executor can look its filer up, and the owner is the one voice on this
    // board every agent already knows — gating him would turn one click on the dashboard into a form.
    const addressed = checkAssignee(body.assignee, repo.listAgents())
    if (!addressed.ok) return NextResponse.json({ ok: false, ...addressed.err }, { status: 400 })
    const assignee = addressed.assignee
    if (!repo.setAssignee(before.id, assignee)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    log('assigned', assignee ? `assignee: ${before.assignee ?? '—'} → ${assignee}` : `assignee cleared (was ${before.assignee ?? '—'})`)
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
