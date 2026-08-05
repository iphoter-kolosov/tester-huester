import { NextResponse } from 'next/server'
import { repo, normalizeVerifyUrl, normalizeSteps } from '@th/db'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 4000

// The comment thread on a ticket. Two authorized callers, mirroring the rest of the API:
//   • Agent — `?projectKey=<read_key>`; may read and post ONLY on reports in its own project. Its comments are
//     attributed to that project, so it is always clear which agent said what.
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
    return { author: project.name, kind: 'agent' as const, report }
  }
  if (!(await isAuthed())) return { error: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }) }
  return { author: 'Вы', kind: 'human' as const, report }
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

  const comment = repo.addComment({ reportId: r.report.id, author: r.author, authorKind: r.kind, body: text, verifyUrl, verifySteps })
  // Journalled so the other side notices without polling the whole board — this is how an agent learns the
  // reporter answered it.
  repo.logEvent({ projectId: r.report.projectId, reportId: r.report.id, kind: 'comment', actor: r.kind === 'agent' ? r.author : 'human', detail: text.slice(0, 200) })
  return NextResponse.json({ ok: true, comment })
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
