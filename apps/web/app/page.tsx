import Link from 'next/link'
import { redirect } from 'next/navigation'
import { repo, type AgentProfile, type EventKind, type Report } from '@th/db'
import Shell from '@/components/shell/Shell'
import CopyId from '@/components/CopyId'
import WorkReport from '@/components/WorkReport'
import RowVerdict from '@/components/mine/RowVerdict'
import AgentChip from '@/components/ui/AgentChip'
import CountBadge from '@/components/ui/CountBadge'
import EmptyState from '@/components/ui/EmptyState'
import SectionHeader from '@/components/ui/SectionHeader'
import StatusPill from '@/components/ui/StatusPill'
import TicketRow from '@/components/ui/TicketRow'
import { agentName, rosterMap, type RosterMap } from '@/components/agents'
import { ROUTE_AGENTS, ROUTE_CONNECT, ROUTE_TICKETS } from '@/components/shell/nav'
import { VIEW_ADDRESSED } from '@/components/boardViews'
import { ST_NEW, ST_TAKEN } from '@/components/status'
import { isAuthed } from '@/lib/auth'
import { ago, agoLong, exact } from '@/lib/time'
import { cx } from '@/lib/cx'
import { collectMine, STUCK_REVIEW_MS, STUCK_TAKEN_MS, type StuckKind } from '@/lib/mine'
import s from '@/components/mine/mine.module.css'

export const dynamic = 'force-dynamic'

// МОЙ ХОД — первый экран владельца. Отвечает на четыре вопроса и ни на один лишний: что ждёт МЕНЯ, что можно
// отдать и кому, кто на связи, что происходит прямо сейчас.
//
// Список «всё, что когда-либо снято» живёт на /tickets. Здесь — только то, где ход за ним: очередь, которую
// физически не может разобрать никто другой (принять или вернуть работу вправе только заказчик тикета либо
// владелец), заданные ему вопросы и то, что стоит слишком долго.

/** Адреса доски. Пришёл хоть один — это старая закладка на доску, и она обязана открыть доску с фильтром. */
const BOARD_PARAMS = ['view', 'arch', 'site', 'project', 'agent', 'type', 'status', 'sort'] as const

/** Сколько строк показывает раздел, прежде чем отправить читать остальное на доску. */
const SECTION_LIMIT = 12
/** Сколько агентов помещается в боковую колонку, прежде чем она перестаёт быть взглядом искоса. */
const ROSTER_LIMIT = 8

const DAY_MS = 24 * 60 * 60 * 1000
const NO_SITE = '(без сайта)'
const days = (ms: number): number => Math.round(ms / DAY_MS)

// Сайт тикета — хост страницы, на которой его сняли.
function host(pageUrl: string | null): string {
  if (!pageUrl) return NO_SITE
  try {
    return new URL(pageUrl).host
  } catch {
    return NO_SITE
  }
}

const EVENT_VERB: Record<EventKind, string> = {
  created: 'поставил тикет',
  status: 'сменил статус',
  edited: 'поправил',
  comment: 'написал',
  archived: 'убрал в архив',
  moved: 'перенёс',
  assigned: 'передал',
}
// Незнакомый вид события показывается собой, а не ближайшим знакомым: журнал не имеет права угадывать.
const eventVerb = (kind: EventKind): string => (EVENT_VERB as Record<string, string | undefined>)[kind] ?? kind

const STUCK_REASON: Record<StuckKind, string> = {
  taken: 'взято в работу и не сдано',
  review: 'сдано и ждёт вашего слова',
}

/** Кто это, с ответом на «отвечал ли он сегодня» прямо в строке: «кому отдать» и «кто возьмёт» — один вопрос. */
function Who({
  label,
  handle,
  profiles,
  roster,
}: {
  label: string
  handle: string | null
  profiles: Map<string, AgentProfile>
  roster: RosterMap
}) {
  if (!handle) return null
  const p = profiles.get(handle)
  return (
    <span className={s.who}>
      <span className={s.wholbl}>{label}</span>
      <AgentChip
        handle={handle}
        title={p ? agentName(handle, roster) : null}
        lastSeen={p ? p.lastSeen : null}
        retired={p ? !p.active : false}
        unknown={!p}
        plain
        href={ROUTE_AGENTS}
      />
    </span>
  )
}

/** Постоянная часть строки тикета: за что его хватать и откуда он. */
function rowMeta(r: Report, projectName: string) {
  // Проекты у него названы по сайтам, поэтому хост печатается, только если он что-то ДОБАВЛЯЕТ к названию
  // проекта. Иначе строка дважды говорит одно и то же слово — а место в меты стоит дорого.
  const site = host(r.pageUrl)
  return (
    <>
      <CopyId id={r.shortId} />
      <span className={s.tag}>{projectName}</span>
      <span title={exact(r.createdAt)}>{agoLong(r.createdAt)}</span>
      {r.pageUrl && site !== projectName ? <span className={s.site}>{site}</span> : null}
    </>
  )
}

export default async function Mine({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // Старая закладка `/?view=review&site=…` обязана открывать доску с тем же фильтром: адрес, которым владелец
  // пользуется, не может умереть от того, что на корне поселился другой экран.
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    const first = typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
    if (first !== undefined) qs.set(k, first)
  }
  if ((BOARD_PARAMS as readonly string[]).some((p) => qs.has(p))) {
    redirect(`${ROUTE_TICKETS}?${qs.toString()}`)
  }

  if (!(await isAuthed())) redirect('/login')

  const now = Date.now()
  const { reviews, questions, stuck, counters, agents, feed, truncated } = collectMine(now)

  const projName = new Map(repo.listProjects().map((p) => [p.id, p.name] as const))
  const nameOf = (projectId: string): string => projName.get(projectId) ?? 'проект'

  // Один справочник состава на весь экран: и чипы в строках, и боковая колонка говорят об агенте одно и то же.
  const profiles = new Map(repo.listAgents().map((a) => [a.handle, a] as const))
  const roster: RosterMap = rosterMap([...profiles.values()])

  const tiles = [
    {
      key: 'review',
      href: '#review',
      n: counters.review,
      label: 'ждут вашей приёмки',
      hint: 'Работа сдана. Принять или вернуть может только заказчик тикета — то есть вы',
      attention: true,
    },
    {
      key: 'addressed',
      href: `${ROUTE_TICKETS}?view=${VIEW_ADDRESSED}`,
      n: counters.addressed,
      label: 'адресовано вам',
      hint: 'Открытые тикеты, где исполнитель — вы',
      attention: false,
    },
    {
      key: 'inwork',
      href: `${ROUTE_TICKETS}?status=${ST_TAKEN}`,
      n: counters.inWork,
      label: 'в работе у агентов',
      hint: 'Кто-то взял и ещё не сдал',
      attention: false,
    },
    {
      key: 'unclaimed',
      href: `${ROUTE_TICKETS}?status=${ST_NEW}`,
      n: counters.unclaimed,
      label: 'никто не взял',
      hint: 'Поставлены и никому не адресованы — это то, что можно отдать',
      attention: false,
    },
    {
      key: 'stuck',
      href: '#stuck',
      n: counters.stuck,
      label: 'застряло',
      hint: `Взято дольше ${days(STUCK_TAKEN_MS)} дн или ждёт приёмки дольше ${days(STUCK_REVIEW_MS)} дн`,
      attention: false,
    },
    {
      key: 'quiet',
      href: ROUTE_AGENTS,
      n: counters.quiet,
      label: 'агентов молчит',
      hint: 'Больше суток не выходили на связь — на них рассчитывать нельзя',
      attention: false,
    },
  ] as const

  const shownQuestions = questions.slice(0, SECTION_LIMIT)
  const shownStuck = stuck.slice(0, SECTION_LIMIT)
  const shownAgents = agents.slice(0, ROSTER_LIMIT)
  // «Всё разобрано» — это ОТВЕТ, а не три пустые рамки подряд. Три «нет данных» в столбик и есть та помойка,
  // от которой этот экран уводит.
  const clear = reviews.length === 0 && questions.length === 0 && stuck.length === 0

  return (
    <Shell active="mine">
      <main className="wrap">
        <SectionHeader
          lead
          plain
          title="Мой ход"
          hint="Что ждёт вашего слова, что можно отдать и кому"
          actions={
            <Link className={s.open} href={ROUTE_TICKETS}>
              вся доска →
            </Link>
          }
        />

        <div className={s.tiles}>
          {tiles.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={cx(s.tile, t.attention && t.n > 0 && s.tile_attention, t.n === 0 && s.tile_zero)}
              title={t.hint}
            >
              <span className={s.tilen}>{t.n}</span>
              <span className={s.tilelbl}>{t.label}</span>
            </Link>
          ))}
        </div>

        {truncated ? (
          <p className={s.warn}>
            Тикетов больше, чем панель берёт за один заход, — цифры выше ЗАНИЖЕНЫ. Разберите очередь или ищите
            на доске.
          </p>
        ) : null}

        <div className={s.cols}>
          <div className={s.col}>
            <section id="review" className={s.block}>
              <SectionHeader
                title="Ждут моей приёмки"
                count={reviews.length}
                countTone="attention"
                countTitle="Столько работ сдано и ждёт вашего слова"
                hint={reviews.length > 1 ? 'сверху — то, что ждёт дольше всех' : undefined}
              />
              {clear ? (
                <EmptyState
                  title="Ход не за вами"
                  hint="Очередь приёмки пуста, вопросов к вам нет, ничего не зависло. Можно ставить новое: Ctrl+Shift+Y снимает тикет прямо со страницы."
                  actions={
                    <Link className={s.action} href={ROUTE_TICKETS}>
                      Открыть доску
                    </Link>
                  }
                />
              ) : reviews.length === 0 ? (
                <EmptyState
                  title="Никто не ждёт вашего слова"
                  hint="Как только агент сдаст работу, тикет встанет сюда с отчётом: что сделано, где смотреть, как проверить и чем доказано."
                />
              ) : null}
              {reviews.map(({ report: r, check, since }) => (
                <div className={s.item} key={r.id}>
                  <TicketRow
                    attention
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    title={r.note || 'без заметки'}
                    meta={rowMeta(r, nameOf(r.projectId))}
                    who={
                      <span className={s.whorow}>
                        <Who label="сдал" handle={r.takenBy ?? r.assignee} profiles={profiles} roster={roster} />
                        <span className={s.waited} title={exact(since)}>
                          ждёт {ago(since, now)}
                        </span>
                      </span>
                    }
                    aside={
                      // Плашки статуса здесь нет намеренно: в этом разделе он у всех один, и повторять его
                      // в каждой строке — значит тратить самое заметное место на слово, уже сказанное
                      // заголовком раздела и полосой внимания.
                      <Link className={s.open} href={`/r/${r.id}`}>
                        открыть тикет →
                      </Link>
                    }
                  >
                    {check ? (
                      <WorkReport
                        author={agentName(check.author, roster)}
                        body={check.body}
                        url={check.verifyUrl}
                        steps={check.verifySteps}
                        evidence={check.evidence}
                        at={check.createdAt}
                      />
                    ) : (
                      // Работу сдали, не приложив ни ссылки, ни шагов, ни доказательства — принимать нечего.
                      <div className="vfymissing">
                        Работа сдана на проверку, но отчёта к ней не приложено: ни ссылки, ни шагов, ни
                        доказательства. Принимать вслепую нечего — верните с просьбой приложить проверку.
                      </div>
                    )}
                    <RowVerdict id={r.id} shortId={r.shortId} />
                  </TicketRow>
                </div>
              ))}
            </section>

            <section id="questions" className={s.block}>
              {/* Цифра тоном внимания: вопрос агента ждёт именно его. Полосы внимания у строк тут нет —
                  она остаётся только у приёмки, иначе два раздела кричат одинаково и оба перестают быть видны. */}
              <SectionHeader
                title="Вопросы ко мне"
                count={questions.length}
                countTone={questions.length > 0 ? 'attention' : 'quiet'}
                countTitle="В стольких тикетах последнее слово осталось за агентом"
                hint="последним в обсуждении говорил агент"
              />
              {questions.length === 0 ? (
                // Когда пусто ВЕЗДЕ, ответ уже дан выше одним блоком — здесь остаётся строка, чтобы раздел не
                // выглядел недогрузившимся и чтобы ссылка-якорь сверху вела в живое место.
                clear ? (
                  <p className={s.more}>Пусто: последнее слово нигде не за агентом.</p>
                ) : (
                  <EmptyState
                    title="Никто ничего не спрашивал"
                    hint="Если агент напишет в обсуждении тикета и останется без ответа, тикет всплывёт сюда — искать его по двадцати карточкам не придётся."
                  />
                )
              ) : null}
              {shownQuestions.map(({ report: r, comment }) => (
                <div className={s.item} key={r.id}>
                  <TicketRow
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    title={r.note || 'без заметки'}
                    meta={rowMeta(r, nameOf(r.projectId))}
                    who={
                      <span className={s.whorow}>
                        <Who label="спросил" handle={comment.author} profiles={profiles} roster={roster} />
                        <span className={s.waited} title={exact(comment.createdAt)}>
                          {agoLong(comment.createdAt, now)}
                        </span>
                      </span>
                    }
                    aside={
                      <>
                        <StatusPill status={r.status} size="sm" />
                        <Link className={s.open} href={`/r/${r.id}`}>
                          ответить →
                        </Link>
                      </>
                    }
                  >
                    <blockquote className={s.quote}>{comment.body}</blockquote>
                  </TicketRow>
                </div>
              ))}
              {questions.length > shownQuestions.length ? (
                <p className={s.more}>
                  Показаны {shownQuestions.length} из {questions.length} — самые свежие.{' '}
                  <Link className={s.open} href={ROUTE_TICKETS}>
                    остальные на доске →
                  </Link>
                </p>
              ) : null}
            </section>

            <section id="stuck" className={s.block}>
              <SectionHeader
                title="Застряло"
                count={stuck.length}
                countTone="quiet"
                countTitle="Столько тикетов стоит дольше срока"
                hint={`взято дольше ${days(STUCK_TAKEN_MS)} дн · ждёт приёмки дольше ${days(STUCK_REVIEW_MS)} дн`}
              />
              {stuck.length === 0 ? (
                clear ? (
                  <p className={s.more}>Пусто: всё, что взято, взято недавно.</p>
                ) : (
                  <EmptyState
                    title="Ничего не зависло"
                    hint={`Взятое возвращают быстрее ${days(STUCK_TAKEN_MS)} дней, а очередь приёмки не старше ${days(STUCK_REVIEW_MS)}.`}
                  />
                )
              ) : null}
              {shownStuck.map(({ report: r, kind, since }) => (
                <div className={s.item} key={`${kind}:${r.id}`}>
                  <TicketRow
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    title={r.note || 'без заметки'}
                    meta={rowMeta(r, nameOf(r.projectId))}
                    who={
                      <span className={s.whorow}>
                        <Who label="держит" handle={r.takenBy ?? r.assignee} profiles={profiles} roster={roster} />
                        <span className={s.stuckwhy} title={exact(since)}>
                          {STUCK_REASON[kind]} · {ago(since, now)}
                        </span>
                      </span>
                    }
                    aside={
                      <>
                        <StatusPill status={r.status} size="sm" />
                        <Link className={s.open} href={`/r/${r.id}`}>
                          открыть тикет →
                        </Link>
                      </>
                    }
                  />
                </div>
              ))}
              {stuck.length > shownStuck.length ? (
                <p className={s.more}>
                  Показаны {shownStuck.length} из {stuck.length} — самые старые.
                </p>
              ) : null}
            </section>
          </div>

          <aside className={s.side}>
            <section className={s.panel}>
              <SectionHeader
                plain
                title="Кому отдать"
                actions={
                  <Link className={s.open} href={ROUTE_AGENTS}>
                    весь состав →
                  </Link>
                }
              />
              {shownAgents.length === 0 ? (
                <EmptyState
                  title="Состав пуст"
                  hint="Пока ни один агент не подключился к доске — передавать работу некому."
                  actions={
                    <Link className={s.action} href={ROUTE_CONNECT}>
                      Как подключить агента
                    </Link>
                  }
                />
              ) : (
                <ul className={s.roster}>
                  {shownAgents.map(({ agent, open }) => (
                    <li className={s.rosterrow} key={agent.handle}>
                      <AgentChip
                        handle={agent.handle}
                        title={agent.title}
                        lastSeen={agent.lastSeen}
                        retired={!agent.active}
                        plain
                        href={ROUTE_AGENTS}
                      />
                      <CountBadge
                        n={open}
                        tone="quiet"
                        title={open ? `${open} открытых тикетов на нём` : 'Свободен — открытых тикетов нет'}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {agents.length > shownAgents.length ? (
                <p className={s.more}>и ещё {agents.length - shownAgents.length} в составе</p>
              ) : null}
            </section>

            <section className={s.panel}>
              <SectionHeader plain title="Что происходит" />
              {feed.length === 0 ? (
                <p className={s.more}>На доске тихо: ни одного события.</p>
              ) : (
                <ul className={s.feed}>
                  {feed.map(({ event, report }) => (
                    <li className={s.feedrow} key={event.seq}>
                      <span className={s.feedwhen} title={exact(event.createdAt)}>
                        {ago(event.createdAt, now)}
                      </span>
                      <span className={s.feedtxt}>
                        <b className={s.feedwho}>{agentName(event.actor, roster)}</b> {eventVerb(event.kind)}{' '}
                        {report ? (
                          <Link className={s.feedlink} href={`/r/${report.id}`} title={report.note || 'без заметки'}>
                            #{report.shortId}
                          </Link>
                        ) : (
                          <span title="Тикет удалён — событие осталось в журнале">удалённый тикет</span>
                        )}
                        {event.detail ? <span className={s.feeddetail}>{event.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </main>
    </Shell>
  )
}
