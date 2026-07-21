import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReproBundle } from '@th/core'
import { repo, type Report } from '@th/db'
import StatusSelect from '@/components/StatusSelect'
import { isAuthed } from '@/lib/auth'

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

const TYPE_LABEL: Record<string, string> = { feature: 'Фича', bug: 'Баг', fix: 'Правка', text: 'Текст' }
const TYPE_ORDER = ['feature', 'bug', 'fix', 'text']
const SEV_LABEL: Record<string, string> = { low: 'low', med: 'med', high: 'high', crit: 'crit' }
const STATUS_ORDER = ['new', 'triaged', 'fixed', 'wontfix']
const NO_SITE = '(no site)'

// The site a note belongs to = the host of the page it was captured on. This is the real "с какого сайта"
// signal — independent of which project (ingest key) it was sent under.
function host(pageUrl: string | null): string {
  if (!pageUrl) return NO_SITE
  try {
    return new URL(pageUrl).host
  } catch {
    return NO_SITE
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; type?: string; status?: string; sort?: string }>
}) {
  if (!(await isAuthed())) redirect('/login')
  const sp = await searchParams
  const f = { site: sp.site || '', type: sp.type || '', status: sp.status || '', sort: sp.sort === 'old' ? 'old' : 'new' }

  const projects = repo.listProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name] as const))
  const all = repo.listReports({ limit: 1000 }) // newest-first from the DB

  // Every distinct site seen in the data — powers the Site filter.
  const siteCounts = new Map<string, number>()
  for (const r of all) siteCounts.set(host(r.pageUrl), (siteCounts.get(host(r.pageUrl)) ?? 0) + 1)
  const siteList = [...siteCounts.keys()].sort((a, b) => (siteCounts.get(b)! - siteCounts.get(a)!) || a.localeCompare(b))

  const matches = (r: Report) =>
    (!f.site || host(r.pageUrl) === f.site) &&
    (!f.type || r.type === f.type) &&
    (!f.status || r.status === f.status)
  const shown = all.filter(matches)
  const hasFilter = !!(f.site || f.type || f.status)

  // Group the visible notes BY SITE. Order notes within a group by the chosen sort; order the groups by their
  // most-recent note so the freshest site floats to the top.
  const bySite = new Map<string, Report[]>()
  for (const r of shown) {
    const k = host(r.pageUrl)
    const arr = bySite.get(k) ?? []
    arr.push(r)
    bySite.set(k, arr)
  }
  const groups = [...bySite.entries()].map(([site, rows]) => {
    rows.sort((a, b) => (f.sort === 'old' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt))
    const newest = Math.max(...rows.map((r) => r.createdAt))
    return { site, rows, newest }
  })
  groups.sort((a, b) => (f.sort === 'old' ? a.newest - b.newest : b.newest - a.newest))

  return (
    <main className="wrap">
      <div className="h">
        <span className="h1">🐞 Reports</span>
        <span className="c">
          {shown.length}
          {hasFilter ? ` / ${all.length}` : ''} notes · {siteList.length} sites
        </span>
      </div>

      {projects.length > 0 && (
        <div className="keys">
          <span className="keyslbl">agent keys</span>
          {projects.map((p) => (
            <span className="keychip" key={p.id} title="Read key — give it to a QA agent (REST ?projectKey= / MCP TH_PROJECT_KEY)">
              <b>{p.name}</b>
              <code>{p.readKey || '—'}</code>
            </span>
          ))}
        </div>
      )}

      <form className="filters" action="/" method="get">
        <select name="site" defaultValue={f.site} className="fsel">
          <option value="">All sites</option>
          {siteList.map((s) => (
            <option key={s} value={s}>{s} ({siteCounts.get(s)})</option>
          ))}
        </select>
        <select name="type" defaultValue={f.type} className="fsel">
          <option value="">Any type</option>
          {TYPE_ORDER.map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
        <select name="status" defaultValue={f.status} className="fsel">
          <option value="">Any status</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select name="sort" defaultValue={f.sort} className="fsel">
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
        </select>
        <button type="submit" className="fbtn">Filter</button>
        {hasFilter || f.sort === 'old' ? <Link href="/" className="freset">Reset</Link> : null}
      </form>

      {all.length === 0 && (
        <div className="empty">No notes yet. Capture from the extension (Ctrl+Shift+Y) or POST to <code>/api/ingest</code>.</div>
      )}
      {all.length > 0 && shown.length === 0 && <div className="empty">No notes match the filter.</div>}

      {groups.map(({ site, rows }) => (
        <section className="proj" key={site}>
          <div className="projhead">
            <div className="projmeta">
              <span className="projname">{site}</span>
              <span className="projcounts">{rows.length} {rows.length === 1 ? 'note' : 'notes'}</span>
            </div>
          </div>

          {rows.map((r) => {
            const badges = contextBadges(r.context) ?? []
            if (r.replayUrl) badges.push({ t: '▶ replay' })
            return (
              <div className="row" key={r.id}>
                {r.screenshotUrl ? <img className="thumb" src={r.screenshotUrl} alt="" /> : <span className="noimg">📷</span>}
                <div className="mid">
                  <div className="tags">
                    <span className={'tp tp-' + r.type}>{TYPE_LABEL[r.type] ?? r.type}</span>
                    {r.severity ? <span className={'sv sv-' + r.severity}>{SEV_LABEL[r.severity] ?? r.severity}</span> : null}
                    <span className="proj-tag">{projName.get(r.projectId) ?? 'project'}</span>
                  </div>
                  <div className={'note' + (r.note ? '' : ' empty2')}>{r.note || 'no note'}</div>
                  <div className="meta">
                    <span>{ago(r.createdAt)}</span>
                    {r.pageUrl && <a href={r.pageUrl} target="_blank" rel="noreferrer">{r.pageUrl}</a>}
                    {r.viewport && <span>{r.viewport}</span>}
                    {r.reporter && <span>· {r.reporter}</span>}
                  </div>
                  {badges.length ? (
                    <div className="badges">
                      {badges.map((b) => (
                        <span key={b.t} className={'badge' + (b.bad ? ' bad' : '')}>{b.t}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="right">
                  <StatusSelect id={r.id} value={r.status} />
                  <Link className="open" href={`/r/${r.id}`}>open →</Link>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </main>
  )
}
