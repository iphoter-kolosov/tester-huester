import { NextResponse } from 'next/server'
import { repo } from '@th/db'
import { storage } from '@/lib/storage'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Upload an image belonging to THIS ticket — typically the report's screenshot with more markup added by the
// reviewer, so it can be referenced from a comment. Two authorised callers, mirroring the rest of the API:
//   • Agent — `?projectKey=<read_key>` may attach only to a report in its own project
//   • Human — dashboard cookie
// The response returns the URL the caller should embed in the comment ("![annotation](url)" is rendered as
// an inline image in the thread), so the flow is: draw → upload → paste into the reply.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const projectKey = new URL(req.url).searchParams.get('projectKey') || ''
  const report = repo.resolveReport(id)
  if (!report) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })

  if (projectKey) {
    const project = repo.getProjectByReadKey(projectKey)
    if (!project) return NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 })
    if (project.id !== report.projectId) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  } else if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }
  const dataUrl = typeof body.image === 'string' ? body.image : ''
  if (!dataUrl.startsWith('data:image/')) {
    return NextResponse.json({ ok: false, error: 'bad_image' }, { status: 400 })
  }
  if (dataUrl.length > 12_000_000) {
    return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  }
  try {
    const url = await storage.put(dataUrl)
    return NextResponse.json({ ok: true, url })
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'store_failed', detail: String((e as Error)?.message || e) }, { status: 500 })
  }
}
