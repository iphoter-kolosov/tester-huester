import { NextResponse } from 'next/server'
import { repo, normalizeIdentity, normalizeVerifyUrl, normalizeSteps, resolveSpeaker, IDENTITY_OWNER } from '@th/db'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 4000
// The dashboard's own label for the human in the thread — a display name, never an identity.
const OWNER_DISPLAY_NAME = 'Вы'

// The comment thread on a ticket. Two authorized callers, mirroring the rest of the API:
//   • Agent — `?projectKey=<read_key>`; may read and post ONLY on reports in its own project. It signs the comment
//     with `agent`; without one the project name still stands in, which is what pre-identity clients get.
//   • Human — the dashboard cookie; may read and post anywhere, and delete.
async function resolve(req: Request, id: string) {
  const projectKey = new URL(req.url).searchParams.get('projectKey') || ''
  const report = repo.resolveReport(id)
  if (!report) return { error: NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 }) }

  if (projectKey) {
    const project = repo.getProjectByReadKey(projectKey)
    if (!project) return { error: NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 }) }
    if (report.projectId !== project.id) {
      return { error: NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 }) }
    }
    return { project, kind: 'agent' as const, report }
  }
  if (!(await isAuthed())) return { error: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }) }
  return { project: null, kind: 'human' as const, report }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const r = await resolve(req, id)
  if ('error' in r) return r.error
  return NextResponse.json({ ok: true, comments: repo.listComments(r.report.id) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const r = await resolve(req, id)
  if ('error' in r) return r.error

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }
  const text = String(body.body ?? '').trim().slice(0, MAX_BODY)
  if (!text) return NextResponse.json({ ok: false, error: 'empty' }, { status: 400 })

  // Optional here (a comment is not a claim), but when present it is validated the same way as on a status
  // change, so a link in the thread is always something the reporter can actually click.
  const verifyUrl = normalizeVerifyUrl(body.verifyUrl)
  const verifySteps = normalizeSteps(body.verifySteps)
  if (body.verifyUrl && !verifyUrl) {
    return NextResponse.json(
      { ok: false, error: 'bad_verify_url', message: 'verifyUrl must be an absolute http(s) link the reporter can open.' },
      { status: 400 },
    )
  }

  // WHO is talking. An agent that signs its comment is the author of that comment and joins the roster by it; one
  // that does not still posts under the board's name, exactly as before — but that name does NOT become an agent,
  // because a thread signed "erental" is a board talking to itself and no reader can tell two agents apart in it.
  const speaker = r.project
    ? resolveSpeaker(body.agent, normalizeIdentity(r.project.name) ?? r.project.id)
    : { identity: IDENTITY_OWNER, rosterHandle: IDENTITY_OWNER }
  if (speaker.rosterHandle) repo.touchAgent(speaker.rosterHandle, r.report.projectId)

  const author = r.kind === 'agent' ? speaker.identity : OWNER_DISPLAY_NAME
  const comment = repo.addComment({ reportId: r.report.id, author, authorKind: r.kind, body: text, verifyUrl, verifySteps })
  // Journalled so the other side notices without polling the whole board — this is how an agent learns the
  // reporter answered it. The journal records the identity, not the display name, so an agent filtering by actor
  // sees one owner and one handle per agent.
  repo.logEvent({ projectId: r.report.projectId, reportId: r.report.id, kind: 'comment', actor: speaker.identity, detail: text.slice(0, 200) })
  return NextResponse.json({ ok: true, comment, agent: r.kind === 'agent' ? speaker.identity : null })
}

// Deleting a comment is the human's call only — an agent must not be able to erase the record.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  await params
  const commentId = new URL(req.url).searchParams.get('commentId') || ''
  if (!commentId) return NextResponse.json({ ok: false, error: 'no_comment_id' }, { status: 400 })
  const ok = repo.deleteComment(commentId)
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
}
