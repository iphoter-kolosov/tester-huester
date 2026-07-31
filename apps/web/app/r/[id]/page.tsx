import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { ReproBundle } from '@th/core'
import { repo } from '@th/db'
import RowControls from '@/components/RowControls'
import EditableNote from '@/components/EditableNote'
import CommentThread from '@/components/CommentThread'
import CopyId from '@/components/CopyId'
import ReproContext from '@/components/ReproContext'
import ReplayPlayer from '@/components/ReplayPlayer'
import VideoPlayer from '@/components/VideoPlayer'
import { isAuthed } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) redirect('/login')
  const { id } = await params
  const r = repo.resolveReport(id)
  if (!r) notFound()
  const projOpts = repo.listProjects().map((p) => ({ value: p.id, label: p.name }))
  const comments = repo.listComments(r.id)
  return (
    <main className="wrap">
      <Link className="back" href="/">← все тикеты</Link>
      <div className="h" style={{ marginTop: 10 }}>
        <span className="h1">
          Тикет <CopyId id={r.shortId} big />
          {r.archived ? <span className="archbadge">в архиве</span> : null}
        </span>
      </div>

      <div className="dctl">
        <RowControls id={r.id} type={r.type} severity={r.severity} status={r.status} projectId={r.projectId} projects={projOpts} archived={r.archived} />
      </div>

      {r.screenshotUrl ? <img className="dshot" src={r.screenshotUrl} alt="" /> : null}

      <EditableNote id={r.id} value={r.note} />

      <div className="dmeta">
        <span className="k">Page</span>
        <span>{r.pageUrl ? <a href={r.pageUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{r.pageUrl}</a> : '—'}</span>
        <span className="k">Viewport</span><span>{r.viewport || '—'}</span>
        <span className="k">Reporter</span><span>{r.reporter || '—'}</span>
        <span className="k">User agent</span><span style={{ color: 'var(--muted)' }}>{r.userAgent || '—'}</span>
        <span className="k">Created</span><span>{new Date(r.createdAt).toLocaleString()}</span>
        <span className="k">ID</span><span style={{ color: 'var(--muted)' }}><CopyId id={r.shortId} /> · {r.id}</span>
      </div>
      <CommentThread reportId={r.id} comments={comments} />

      {r.context ? <ReproContext context={r.context as ReproBundle} /> : null}
      {r.videoUrl ? <VideoPlayer url={r.videoUrl} seconds={r.videoSeconds} /> : r.replayUrl ? <ReplayPlayer url={r.replayUrl} /> : null}
    </main>
  )
}
