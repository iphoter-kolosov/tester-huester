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

// Note taxonomy → RU labels + colour class (see globals.css .tp-*).
const TYPE_LABEL: Record<string, string> = { feature: 'Фича', bug: 'Баг', fix: 'Правка', text: 'Текст' }
const TYPE_ORDER = ['feature', 'bug', 'fix', 'text']
const SEV_LABEL: Record<string, string> = { low: 'low', med: 'med', high: 'high', crit: 'crit' }
const STATUS_ORDER = ['new', 'triaged', 'fixed', 'wontfix']

// Origin (host) of the page the note was captured on — used as the sub-grouping signal within a project.
function host(pageUrl: string | null): string | null {
  if (!pageUrl) return null
  try {
    return new URL(pageUrl).host
  } catch {
    return null
  }
}

export default async function Home({ searchParams }: { searchParams: Promise<{ project?: string; type?: string; status?: string }> }) {
  if (!(await isAuthed())) redirect('/login')
  const sp = await searchParams
  const f = {
    project: sp.project || '',
    type: sp.type || '',
    status: sp.status || '',
  }

  const projects = repo.listProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name] as const))
  // Fetch everything once; totals need the unfiltered set, the list applies the active filters in JS.
  const all = repo.listReports({ limit: 500 })

  const matches = (r: Report) =>
    (!f.project || r.projectId === f.project) &&
    (!f.type || r.type === f.type) &&
    (!f.status || r.status === f.status)
  const shown = all.filter(matches)

  const byProject = new Map<string, Report[]>()
  for (const r of shown) {
    const arr = byProject.get(r.projectId) ?? []
    arr.push(r)
    byProject.set(r.projectId, arr)
  }
  const totalNew = (pid: string) => all.filter((r) => r.projectId === pid && r.status === 'new').length
  const totalAll = (pid: string) => all.filter((r) => r.projectId === pid).length

  // Show the selected project only when filtering by it; otherwise every project (so read keys stay visible).
  const visibleProjects = f.project ? projects.filter((p) => p.id === f.project) : projects
  const hasFilter = !!(f.project || f.type || f.status)

  return (
    <main className="wrap">
      <div className="h">
        <span className="h1">🐞 Reports</span>
        <span className="c">{shown.length}{hasFilter ? ` / ${all.length}` : ''} notes · {projects.length} sites</span>
      </div>

      <form className="filters" action="/" method="get">
        <select name="project" defaultValue={f.project} className="fsel">
          <option value="">All sites</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
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
        <button type="submit" className="fbtn">Filter</button>
        {hasFilter ? <Link href="/" className="freset">Reset</Link> : null}
      </form>

      {projects.length === 0 && (
        <div className="empty">No sites yet. Seed a project, then capture from the extension (or POST to <code>/api/ingest</code>).</div>
      )}

      {visibleProjects.map((p) => {
        const rows = byProject.get(p.id) ?? []
        return (
          <section className="proj" key={p.id}>
            <div className="projhead">
              <div className="projmeta">
                <span className="projname">{p.name}</span>
                <span className="projcounts">{totalNew(p.id)} new · {totalAll(p.id)} total</span>
              </div>
              <div className="projkey" title="Read key — give this to a QA agent (REST ?projectKey= / MCP TH_PROJECT_KEY)">
                <span className="projkeylbl">agent key</span>
                <code>{p.readKey || '—'}</code>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="projempty">{hasFilter ? 'No notes match the filter.' : 'No notes yet.'}</div>
            ) : (
              rows.map((r) => {
                const badges = contextBadges(r.context) ?? []
                if (r.replayUrl) badges.push({ t: '▶ replay' })
                const org = host(r.pageUrl)
                return (
                  <div className="row" key={r.id}>
                    {r.screenshotUrl ? <img className="thumb" src={r.screenshotUrl} alt="" /> : <span className="noimg">📷</span>}
                    <div className="mid">
                      <div className="tags">
                        <span className={'tp tp-' + r.type}>{TYPE_LABEL[r.type] ?? r.type}</span>
                        {r.severity ? <span className={'sv sv-' + r.severity}>{SEV_LABEL[r.severity] ?? r.severity}</span> : null}
                        {org ? <span className="org">{org}</span> : null}
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
              })
            )}
          </section>
        )
      })}
    </main>
  )
}
