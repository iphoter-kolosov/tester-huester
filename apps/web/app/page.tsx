import Link from 'next/link'
import { repo } from '@th/db'
import StatusSelect from '@/components/StatusSelect'

export const dynamic = 'force-dynamic'

function ago(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default async function Home() {
  const rows = repo.listReports({ limit: 200 })
  return (
    <main className="wrap">
      <div className="h">
        <span className="h1">🐞 Reports</span>
        <span className="c">{rows.length} total</span>
      </div>
      {rows.length === 0 && (
        <div className="empty">No reports yet. Capture one from the extension (or POST to <code>/api/ingest</code>).</div>
      )}
      {rows.map((r) => (
        <div className="row" key={r.id}>
          {r.screenshotUrl ? <img className="thumb" src={r.screenshotUrl} alt="" /> : <span className="noimg">📷</span>}
          <div className="mid">
            <div className={'note' + (r.note ? '' : ' empty2')}>{r.note || 'no note'}</div>
            <div className="meta">
              <span>{ago(r.createdAt)}</span>
              {r.pageUrl && <a href={r.pageUrl} target="_blank" rel="noreferrer">{r.pageUrl}</a>}
              {r.viewport && <span>{r.viewport}</span>}
              {r.reporter && <span>· {r.reporter}</span>}
            </div>
          </div>
          <div className="right">
            <StatusSelect id={r.id} value={r.status} />
            <Link className="open" href={`/r/${r.id}`}>open →</Link>
          </div>
        </div>
      ))}
    </main>
  )
}
