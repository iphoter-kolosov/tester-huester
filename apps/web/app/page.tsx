import Link from 'next/link'
import type { ReproBundle } from '@th/core'
import { repo } from '@th/db'
import StatusSelect from '@/components/StatusSelect'

export const dynamic = 'force-dynamic'

// Compact "console N · net M · steps K · X err" badges from the repro bundle, if any.
function contextBadges(context: unknown) {
  const c = context as ReproBundle | null
  if (!c) return null
  const errs = (c.console ?? []).filter((x) => x.level === 'error').length
  const badges: { t: string; bad?: boolean }[] = []
  if (c.actions?.length) badges.push({ t: `${c.actions.length} steps` })
  if (c.console?.length) badges.push({ t: `${c.console.length} console` })
  if (c.network?.length) badges.push({ t: `${c.network.length} net` })
  if (errs) badges.push({ t: `${errs} err`, bad: true })
  return badges.length ? badges : null
}

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
            {(() => {
              const badges = contextBadges(r.context) ?? []
              if (r.replayUrl) badges.push({ t: '▶ replay' })
              return badges.length ? (
                <div className="badges">
                  {badges.map((b) => (
                    <span key={b.t} className={'badge' + (b.bad ? ' bad' : '')}>{b.t}</span>
                  ))}
                </div>
              ) : null
            })()}
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
