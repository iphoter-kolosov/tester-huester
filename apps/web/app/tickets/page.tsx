import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import type { ReproBundle } from '@th/core'
import {
  repo,
  sameIdentity,
  statusQueryTargets,
  IDENTITY_OWNER,
  STATUS_NEEDS_REVIEW,
  type AgentProfile,
  type Report,
} from '@th/db'
import Shell from '@/components/shell/Shell'
import SectionHeader from '@/components/ui/SectionHeader'
import EmptyState from '@/components/ui/EmptyState'
import TicketRow from '@/components/ui/TicketRow'
import CopyId from '@/components/CopyId'
import FilterBar from '@/components/tickets/FilterBar'
import StatusSelect from '@/components/tickets/StatusSelect'
import AssignPicker, { type AssignableAgent } from '@/components/tickets/AssignPicker'
import ArchiveToggle from '@/components/tickets/ArchiveToggle'
import { TICKET_TYPES } from '@/components/tickets/vocab'
import { agentName, rosterMap, type RosterMap } from '@/components/agents'
import { participantsOf } from '@/lib/roster'
import { ago, exact } from '@/lib/time'
import { cx } from '@/lib/cx'
import { ROUTE_CONNECT } from '@/components/shell/nav'
import {
  BOARD_VIEWS,
  VIEW_ADDRESSED,
  VIEW_FILED,
  VIEW_REVIEW,
  asBoardView,
  type BoardView,
  type ViewCounts,
} from '@/components/boardViews'
import { isAuthed } from '@/lib/auth'
import s from './board.module.css'

export const dynamic = 'force-dynamic'

// ДОСКА. Прежняя строка показывала около двенадцати сведений одинаковой громкостью, и поэтому не читалась
// ни одна. Здесь строка отвечает ровно на четыре вопроса — что это (снимок и первая строка заметки), в
// каком оно состоянии, чьё оно и сколько ему лет, — а всё остальное живёт на странице тикета.
//
// Правая часть строки — четыре колонки постоянной ширины, поэтому список читается сверху вниз одним
// столбцом, а не зигзагом. Передача работы стоит прямо в строке: владелец говорил, что не понимает, может
// ли отдать тикет и кто его возьмёт, — значит ответ обязан быть там, где лежит работа.

/** Столько строк на страницу. Доска — архив на сотни тикетов, и каждая строка тянет ещё и снимок. */
const PAGE_SIZE = 60

/** Потолок выборки repo.listReports. Названо явно: упёршийся счётчик — это НЕ «столько и есть». */
const TICKET_CEILING = 1000

const NO_SITE = '(без сайта)'
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TICKET_TYPES.map((t) => [t.value, t.label]))

// Важность отмечается только выше обычной: подпись «обычная» на каждой строке — шум, а не сведение.
const SEVERITY_MARK: Record<string, { label: string; cls: string | undefined } | undefined> = {
  high: { label: 'важно', cls: s.sev_high },
  crit: { label: 'критично', cls: s.sev_crit },
}

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

// What each selection means, one predicate per view. Keyed by BoardView so adding a view to the toolbar without
// saying what it selects fails the build. The owner is an identity like any other here — he files tickets and
// gets addressed exactly the way an agent does — so "мне" is an identity comparison, not a special case.
const VIEW_MATCH: Record<BoardView, (r: Report) => boolean> = {
  [VIEW_REVIEW]: (r) => r.status === STATUS_NEEDS_REVIEW,
  [VIEW_ADDRESSED]: (r) => sameIdentity(r.assignee, IDENTITY_OWNER),
  [VIEW_FILED]: (r) => sameIdentity(r.creator, IDENTITY_OWNER),
}
const inView = (r: Report, view: BoardView): boolean => VIEW_MATCH[view](r)

// "Чья это работа" — one question, three ways a handle can be attached to a ticket. Splitting the filter into
// three controls would make the owner pick a relationship before he knows there is one; what he actually wants is
// everything this agent has anything to do with.
const touches = (r: Report, handle: string): boolean =>
  r.creator === handle || r.assignee === handle || r.takenBy === handle

const identitiesOf = (r: Report): (string | null)[] => [r.creator, r.assignee, r.takenBy]

// Поиск идёт по тому, чем тикет называют вслух: заметка, короткий идентификатор, адрес страницы и любой из
// трёх handle. Одно поле вместо четырёх — владелец ищет «тот тикет про корзину», а не «тикет, у которого
// поле note содержит».
function haystack(r: Report): string {
  return [r.note, r.shortId, r.pageUrl, r.creator, r.assignee, r.takenBy, r.reporter]
    .filter((v): v is string => !!v)
    .join(' ')
    .toLowerCase()
}

/** Значки доказательств: чем этот тикет подкреплён. Сами доказательства — на странице тикета. */
function evidenceMarks(r: Report, comments: number): ReactNode {
  const c = r.context as ReproBundle | null
  const steps = c?.actions?.length ?? 0
  const errors = (c?.console ?? []).filter((x) => x.level === 'error').length
  const marks: { key: string; text: string; hint: string; bad?: boolean }[] = []
  if (r.attachments.length) marks.push({ key: 'att', text: `📎 ${r.attachments.length}`, hint: `${r.attachments.length} размеченных вложений` })
  if (r.videoUrl) marks.push({ key: 'vid', text: '🎥', hint: 'Есть запись экрана' })
  else if (r.replayUrl) marks.push({ key: 'rep', text: '▶', hint: 'Есть запись сессии' })
  if (steps) marks.push({ key: 'st', text: `⌨ ${steps}`, hint: `${steps} записанных шагов` })
  if (errors) marks.push({ key: 'err', text: `⚠ ${errors}`, hint: `${errors} ошибок в консоли`, bad: true })
  if (comments) marks.push({ key: 'cmt', text: `💬 ${comments}`, hint: `${comments} сообщений в обсуждении` })
  if (!marks.length) return null
  return (
    <span className={s.marks}>
      {marks.map((m) => (
        <span key={m.key} className={cx(s.mark, m.bad && s.mark_bad)} title={m.hint}>
          {m.text}
        </span>
      ))}
    </span>
  )
}

function toAssignable(a: AgentProfile): AssignableAgent {
  return { handle: a.handle, title: a.title, role: a.role, active: a.active, lastSeen: a.lastSeen }
}

export default async function Tickets({
  searchParams,
}: {
  searchParams: Promise<{
    site?: string; type?: string; status?: string; sort?: string; project?: string
    arch?: string; view?: string; agent?: string; q?: string; page?: string
  }>
}) {
  if (!(await isAuthed())) redirect('/login')
  const sp = await searchParams
  const arch = sp.arch === '1'
  const view = asBoardView(sp.view)
  const f = {
    site: sp.site || '',
    type: sp.type || '',
    status: sp.status || '',
    project: sp.project || '',
    agent: sp.agent || '',
    q: (sp.q || '').trim().toLowerCase(),
    sort: sp.sort === 'old' ? 'old' : 'new',
  }

  const projects = repo.listProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name] as const))
  const projOpts = projects.map((p) => ({ value: p.id, label: p.name }))
  const all = repo.listReports({ archived: arch, limit: TICKET_CEILING }) // newest-first from the DB
  const archivedCount = repo.listReports({ archived: true, limit: TICKET_CEILING }).length

  // Every distinct site in the current view — powers the Site filter.
  const siteCounts = new Map<string, number>()
  for (const r of all) siteCounts.set(host(r.pageUrl), (siteCounts.get(host(r.pageUrl)) ?? 0) + 1)
  const siteOpts = [...siteCounts.keys()]
    .sort((a, b) => (siteCounts.get(b)! - siteCounts.get(a)!) || a.localeCompare(b))
    .map((site) => ({ value: site, label: `${site} (${siteCounts.get(site)})` }))

  // Who these tickets belong to, with the roster attached so a row says a name instead of a handle. Built from the
  // handles actually present in this tab: an agent that has never touched a ticket would only ever select an empty
  // board, and a legacy board name that HAS touched hundreds must stay selectable — it is where the work is.
  const participants = participantsOf(all.flatMap(identitiesOf))
  const roster: RosterMap = rosterMap(participants.agents)
  const agentCounts = new Map<string, number>()
  for (const r of all) for (const h of new Set(identitiesOf(r).filter((h): h is string => !!h))) agentCounts.set(h, (agentCounts.get(h) ?? 0) + 1)
  const unknownAgents = new Set(participants.unknown)
  const agentOpts = [...agentCounts.keys()]
    .sort((a, b) => (agentCounts.get(b)! - agentCounts.get(a)!) || a.localeCompare(b))
    .map((h) => ({
      value: h,
      label: `${agentName(h, roster)} (${agentCounts.get(h)})${unknownAgents.has(h) ? ' · не в составе' : ''}`,
    }))

  // Весь состав, а не только те, кто уже что-то трогал: передавать работу можно и тому, кто на этой вкладке
  // пока ни при чём — иначе новый агент никогда не получит первый тикет.
  const addressable = repo.listAgents().map(toAssignable)

  // Counted over the whole tab, not over the current filter: a queue that says "0" only because a site filter is
  // on would be a lie about how much work is waiting.
  const viewCounts = Object.fromEntries(
    BOARD_VIEWS.map((v) => [v, all.filter((r) => inView(r, v)).length]),
  ) as ViewCounts

  const matches = (r: Report) =>
    (!f.site || host(r.pageUrl) === f.site) &&
    (!f.type || r.type === f.type) &&
    // A bookmarked ?status=fixed still means something: the core maps a legacy name onto the rows it became.
    (!f.status || statusQueryTargets(f.status).includes(r.status)) &&
    (!f.project || r.projectId === f.project) &&
    (!f.agent || touches(r, f.agent)) &&
    (!f.q || haystack(r).includes(f.q)) &&
    (!view || inView(r, view))

  const shown = all.filter(matches)
  shown.sort((a, b) => (f.sort === 'old' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt))

  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  // Страница из адреса может оказаться за пределами нового отбора — тогда показываем последнюю, а не пустоту,
  // которая читается как «ничего не нашлось».
  const page = Math.min(Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1), pages)
  const from = (page - 1) * PAGE_SIZE
  const rows = shown.slice(from, from + PAGE_SIZE)

  const pageHref = (n: number): string => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) if (v) p.set(k, v)
    if (n > 1) p.set('page', String(n))
    else p.delete('page')
    return p.toString() ? `/tickets?${p}` : '/tickets'
  }

  const hasFilter = !!(f.site || f.type || f.status || f.project || f.agent || f.q || view)
  const manyProjects = projOpts.length > 1

  return (
    <Shell active="tickets">
      <main className={cx('wrap', s.board)}>
        <SectionHeader
          lead
          title={arch ? 'Архив' : 'Тикеты'}
          hint={
            shown.length
              ? `показано ${from + 1}–${from + rows.length} из ${shown.length}${hasFilter ? ` (всего ${all.length})` : ''}`
              : `${all.length} ${arch ? 'в архиве' : 'на доске'}`
          }
        />

        {all.length >= TICKET_CEILING ? (
          <p className={s.ceiling}>
            Выборка упёрлась в потолок в {TICKET_CEILING} тикетов: показано не всё, и любая цифра на этом экране
            занижена. Сузьте отбор — сайтом, проектом или поиском.
          </p>
        ) : null}

        <FilterBar
          sites={siteOpts}
          projects={projOpts}
          agents={agentOpts}
          archivedCount={archivedCount}
          views={viewCounts}
        />

        {all.length === 0 ? (
          <EmptyState
            title={arch ? 'Архив пуст' : 'На доске пока ни одного тикета'}
            hint={
              arch
                ? 'Сюда попадает всё, что убрано с доски. Убрать тикет можно кнопкой «В архив» в его строке.'
                : 'Снимайте баги расширением (Ctrl+Shift+Y) или подключите агента, чтобы он ставил тикеты сам.'
            }
            actions={arch ? null : <Link className={s.linkbtn} href={ROUTE_CONNECT}>Подключить агента</Link>}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title={view === VIEW_REVIEW ? 'Очередь на проверку пуста' : 'Ничего не подошло под отбор'}
            hint={
              view === VIEW_REVIEW
                ? 'Никто не ждёт вашего слова: сданной и непринятой работы на доске нет.'
                : 'Снимите лишние условия — кнопка «сбросить» стоит в конце полосы отбора.'
            }
          />
        ) : (
          <>
            <div className={s.head}>
              <span />
              <span className={s.headk}>тикет</span>
              <div className={s.aside}>
                <span className={s.headk}>статус</span>
                <span className={s.headk}>кому</span>
                <span className={cx(s.headk, s.headk_right)}>возраст</span>
                <span />
              </div>
            </div>

            <div className={s.list}>
              {rows.map((r) => {
                const comments = repo.countComments(r.id)
                const sev = r.severity ? SEVERITY_MARK[r.severity] : undefined
                // «Держит» показывается только когда это отдельное сведение: тот же агент в колонке «кому»
                // уже назван, и повторять его второй раз — ровно тот шум, из-за которого строка не читалась.
                const holderShown = r.takenBy && r.takenBy !== r.assignee ? r.takenBy : null
                const filerShown = r.creator && !sameIdentity(r.creator, IDENTITY_OWNER) ? r.creator : null
                return (
                  <TicketRow
                    key={r.id}
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    attention={r.status === STATUS_NEEDS_REVIEW}
                    dimmed={r.archived}
                    title={r.note || <span className={s.nonote}>без заметки</span>}
                    meta={
                      <>
                        <span className={s.host} title={r.pageUrl ?? 'Страница не записана'}>{host(r.pageUrl)}</span>
                        <CopyId id={r.shortId} />
                        {manyProjects ? <span className={s.tag}>{projName.get(r.projectId) ?? 'проект'}</span> : null}
                        <span className={s.tag}>{TYPE_LABEL[r.type] ?? r.type}</span>
                        {sev ? <span className={cx(s.tag, sev.cls)}>{sev.label}</span> : null}
                        {filerShown ? (
                          <span className={s.holder}>
                            от <span className={s.holderh}>{agentName(filerShown, roster)}</span>
                          </span>
                        ) : null}
                        {holderShown ? (
                          <span className={s.holder} title="Этот агент держит тикет в работе прямо сейчас">
                            держит <span className={s.holderh}>{agentName(holderShown, roster)}</span>
                          </span>
                        ) : null}
                        {evidenceMarks(r, comments)}
                      </>
                    }
                    aside={
                      <div className={s.aside}>
                        <StatusSelect id={r.id} status={r.status} label={`Статус тикета #${r.shortId}`} />
                        <AssignPicker
                          id={r.id}
                          assignee={r.assignee}
                          roster={addressable}
                          assigneeUnknown={!!r.assignee && unknownAgents.has(r.assignee)}
                        />
                        <span className={s.age} title={exact(r.createdAt)}>{ago(r.createdAt)}</span>
                        <span className={s.act}>
                          <ArchiveToggle id={r.id} archived={r.archived} compact />
                        </span>
                      </div>
                    }
                  />
                )
              })}
            </div>

            {pages > 1 ? (
              <nav className={s.pager} aria-label="Страницы доски">
                {page > 1 ? <Link className={s.linkbtn} href={pageHref(page - 1)}>← назад</Link> : <span />}
                <span className={s.pagerat}>страница {page} из {pages}</span>
                {page < pages ? <Link className={s.linkbtn} href={pageHref(page + 1)}>дальше →</Link> : <span />}
              </nav>
            ) : null}
          </>
        )}
      </main>
    </Shell>
  )
}
