import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReproBundle } from '@th/core'
import { repo } from '@th/db'
import StatusSelect from '@/components/StatusSelect'
import ReproContext from '@/components/ReproContext'

export const dynamic = 'force-dynamic'

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const r = repo.getReport(id)
  if (!r) notFound()
  return (
    <main className="wrap">
      <Link className="back" href="/">← all reports</Link>
      <div className="h" style={{ marginTop: 10 }}>
        <span className="h1">Report</span>
        <StatusSelect id={r.id} value={r.status} />
      </div>
      {r.screenshotUrl ? <img className="dshot" src={r.screenshotUrl} alt="" /> : null}
      {r.note ? <div className="dnote">{r.note}</div> : null}
      <div className="dmeta">
        <span className="k">Page</span>
        <span>{r.pageUrl ? <a href={r.pageUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{r.pageUrl}</a> : '—'}</span>
        <span className="k">Viewport</span><span>{r.viewport || '—'}</span>
        <span className="k">Reporter</span><span>{r.reporter || '—'}</span>
        <span className="k">User agent</span><span style={{ color: 'var(--muted)' }}>{r.userAgent || '—'}</span>
        <span className="k">Created</span><span>{new Date(r.createdAt).toLocaleString()}</span>
        <span className="k">ID</span><span style={{ color: 'var(--muted)' }}>{r.id}</span>
      </div>
      {r.context ? <ReproContext context={r.context as ReproBundle} /> : null}
    </main>
  )
}
