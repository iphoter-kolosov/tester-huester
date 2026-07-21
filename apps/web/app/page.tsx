import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { ReproBundle } from '@th/core'
import { repo, type Report } from '@th/db'
import Filters from '@/components/Filters'
import RowControls from '@/components/RowControls'
import { isAuthed } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Create a new project bucket (human, dashboard-only). Its generated keys appear in the strip: give the read
// key to a dev agent, point the extension's ingest key here to route new captures into it.
async function createProject(formData: FormData) {
  'use server'
  if (!(await isAuthed())) return
  const name = String(formData.get('name') || '').trim()
  if (name) repo.createProject(name)
  revalidatePath('/')
}

// Rotate a project's agent read key (human, dashboard-only). Use when a key leaks — the old one dies instantly.
async function regenerateKey(formData: FormData) {
  'use server'
  if (!(await isAuthed())) return
  const id = String(formData.get('projectId') || '')
  if (id) repo.regenerateReadKey(id)
  revalidatePath('/')
}

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
  if (mins < 1) return 'сейчас'
  if (mins < 60) return `${mins} мин`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} дн`
}

const TYPE_LABEL: Record<string, string> = { feature: 'Фича', bug: 'Баг', fix: 'Правка', text: 'Текст' }
const NO_SITE = '(без сайта)'

// The site a note belongs to = the host of the page it was captured on — the real "с какого сайта" signal,
// independent of which project (ingest key) it was sent under.
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
  searchParams: Promise<{ site?: string; type?: string; status?: string; sort?: string; project?: string; arch?: string }>
}) {
  if (!(await isAuthed())) redirect('/login')
  const sp = await searchParams
  const arch = sp.arch === '1'
  const f = { site: sp.site || '', type: sp.type || '', status: sp.status || '', project: sp.project || '', sort: sp.sort === 'old' ? 'old' : 'new' }

  const projects = repo.listProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name] as const))
  const projOpts = projects.map((p) => ({ value: p.id, label: p.name }))
  const all = repo.listReports({ archived: arch, limit: 1000 }) // newest-first from the DB
  const archivedCount = repo.listReports({ archived: true, limit: 1000 }).length

  // Every distinct site in the current view — powers the Site filter.
  const siteCounts = new Map<string, number>()
  for (const r of all) siteCounts.set(host(r.pageUrl), (siteCounts.get(host(r.pageUrl)) ?? 0) + 1)
  const siteList = [...siteCounts.keys()].sort((a, b) => (siteCounts.get(b)! - siteCounts.get(a)!) || a.localeCompare(b))
  const siteOpts = siteList.map((s) => ({ value: s, label: `${s} (${siteCounts.get(s)})` }))

  const matches = (r: Report) =>
    (!f.site || host(r.pageUrl) === f.site) &&
    (!f.type || r.type === f.type) &&
    (!f.status || r.status === f.status) &&
    (!f.project || r.projectId === f.project)
  const shown = all.filter(matches)
  const hasFilter = !!(f.site || f.type || f.status || f.project)

  // Group visible notes BY SITE; order notes within a group by the chosen sort; float the freshest site up.
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
        <span className="h1">
          <span className="hdot" /> QA cabinet
        </span>
        <span className="c">
          {shown.length}
          {hasFilter ? ` / ${all.length}` : ''} {arch ? 'в архиве' : 'тикетов'} · {siteList.length} сайтов
        </span>
      </div>

      <div className="keys">
        <span className="keyslbl">projects</span>
        {projects.map((p) => (
          <span className="keychip" key={p.id}>
            <b>{p.name}</b>
            <span className="keyrow" title="Give this to a dev agent: scoped read + status writes (MCP TH_PROJECT_KEY / REST ?projectKey=)">
              <span className="keyk">agent</span>
              <code>{p.readKey || '—'}</code>
              <form action={regenerateKey} className="keyref">
                <input type="hidden" name="projectId" value={p.id} />
                <button type="submit" className="keyre" title="Regenerate this key — the old one stops working immediately">↻</button>
              </form>
            </span>
            <span className="keyrow" title="Point the extension's ingest key here to route new captures into this project">
              <span className="keyk">ingest</span>
              <code>{p.ingestKey}</code>
            </span>
          </span>
        ))}
        <form className="newproj" action={createProject}>
          <input name="name" placeholder="new project…" className="npin" maxLength={40} required />
          <button type="submit" className="npbtn">+ Add</button>
        </form>
      </div>

      <Filters sites={siteOpts} projects={projOpts} archivedCount={archivedCount} />

      {all.length === 0 && (
        <div className="empty">
          {arch ? 'Архив пуст.' : <>Пока нет тикетов. Снимайте из расширения (Ctrl+Shift+Y) или POST в <code>/api/ingest</code>.</>}
        </div>
      )}
      {all.length > 0 && shown.length === 0 && <div className="empty">Ничего не подходит под фильтр.</div>}

      {groups.map(({ site, rows }) => (
        <section className="proj" key={site}>
          <div className="projhead">
            <div className="projmeta">
              <span className="projname">{site}</span>
              <span className="projcounts">{rows.length}</span>
            </div>
          </div>

          {rows.map((r) => {
            const badges = contextBadges(r.context) ?? []
            if (r.replayUrl) badges.push({ t: '▶ replay' })
            return (
              <div className={'row' + (r.archived ? ' row-arch' : '')} key={r.id}>
                <Link className="rowthumb" href={`/r/${r.id}`}>
                  {r.screenshotUrl ? <img className="thumb" src={r.screenshotUrl} alt="" /> : <span className="noimg">📷</span>}
                </Link>
                <div className="mid">
                  <Link className={'note' + (r.note ? '' : ' empty2')} href={`/r/${r.id}`}>{r.note || 'без заметки'}</Link>
                  <div className="meta">
                    <span className="proj-tag">{projName.get(r.projectId) ?? 'project'}</span>
                    <span>{ago(r.createdAt)}</span>
                    {r.pageUrl && <a href={r.pageUrl} target="_blank" rel="noreferrer">{r.pageUrl}</a>}
                    {r.viewport && <span>{r.viewport}</span>}
                  </div>
                  {badges.length ? (
                    <div className="badges">
                      {badges.map((b) => (
                        <span key={b.t} className={'badge' + (b.bad ? ' bad' : '')}>{b.t}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <RowControls
                  id={r.id}
                  type={r.type}
                  severity={r.severity}
                  status={r.status}
                  projectId={r.projectId}
                  projects={projOpts}
                  archived={r.archived}
                />
              </div>
            )
          })}
        </section>
      ))}
    </main>
  )
}
