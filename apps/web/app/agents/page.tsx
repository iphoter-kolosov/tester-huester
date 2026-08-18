import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  repo,
  MAX_AGENT_ROLE_LEN,
  MAX_AGENT_TITLE_LEN,
  STATUS_NEEDS_REVIEW,
  STATUS_REJECTED,
  STATUS_TAKEN,
  type AgentProfile,
  type AuthorKind,
  type Report,
} from '@th/db'
import AgentEditor from '@/components/AgentEditor'
import { UNKNOWN_HINT } from '@/components/agents'
import { VIEW_REVIEW } from '@/components/boardViews'
import Shell from '@/components/shell/Shell'
import { ROUTE_CONNECT, ROUTE_TICKETS } from '@/components/shell/nav'
import EmptyState from '@/components/ui/EmptyState'
import SectionHeader from '@/components/ui/SectionHeader'
import { isAuthed } from '@/lib/auth'
import { cx } from '@/lib/cx'
import { LIVENESS_HINT, LIVENESS_LABEL, liveness, type Liveness } from '@/lib/liveness'
import { ago, agoLong, exact } from '@/lib/time'
import s from './roster.module.css'

export const dynamic = 'force-dynamic'

// Кто работает эту доску. Экран отвечает на два вопроса, которые владелец задаёт перед КАЖДОЙ передачей
// работы: кому это можно отдать и кто уже молчит настолько, что «наверное, он делает» стало неправдой.
// Поэтому карточка агента — не строка таблицы: в ней стоит роль (её читают, решая, чья это задача),
// живость (её видно по полосе слева, до чтения) и то, что на нём висит прямо сейчас.

// repo.listReports отказывается отдавать больше этого. Спросив ровно потолок и получив ровно потолок,
// отличить «столько и есть» от «здесь запрос кончился» нельзя — поэтому потолок назван и проверяется.
const TICKET_CEILING = 1000

// Реплики владельца подписаны отображаемым именем, а не личностью; handle'ы состава — только у агентов.
const AGENT_VOICE: AuthorKind = 'agent'

// Переменная, которой агент называет себя на своей стороне. Названа здесь, потому что подсказка «как чинить»
// печатает именно её: разъедется с @th/db — увидим на /agents/connect, где та же строка собрана из кода.
const ENV_AGENT = 'TH_AGENT'

/**
 * Что на агенте висит.
 *
 * Первые три считаются ТОЧНО так же, как их отбирает доска (`touches`), потому что каждая из них — ссылка,
 * а цифра обязана совпадать со списком, который по ней откроется. Последние две — не ссылки: у доски нет
 * фильтра «только адресованные» и «только поставленные», и врать ссылкой хуже, чем оставить число без неё.
 */
type Tally = {
  /** needs_review — очередь ВЛАДЕЛЬЦА, закрыть её больше некому. */
  review: number
  /** taken — взято и не сдано. */
  working: number
  /** rejected — вернули на доработку, работа продолжается. */
  rework: number
  /** assignee, без архива. */
  addressed: number
  /** creator, считая архив: авторство не истекает. */
  filed: number
}
const emptyTally = (): Tally => ({ review: 0, working: 0, rework: 0, addressed: 0, filed: 0 })

const identitiesOf = (r: Report): (string | null)[] => [r.creator, r.assignee, r.takenBy]

// Где handle прозвучал. Половинки не складываются: по тикетам доска фильтровать умеет, по репликам — нет,
// а имя, живущее ТОЛЬКО в переписке, — самый чистый вид поломки: голос, который ничего не держит.
type Voice = { tickets: number; comments: number }
const emptyVoice = (): Voice => ({ tickets: 0, comments: 0 })

/** Куда ведёт цифра. Один сборщик адреса на экран — иначе фильтры доски расходятся по строкам кода. */
function boardHref(params: Record<string, string>): string {
  return `${ROUTE_TICKETS}?${new URLSearchParams(params).toString()}`
}

// Состояние строки состава. `retired` — не живость: агент вне службы может быть сколь угодно свеж, работу
// ему всё равно не адресуют, и стоять он должен отдельно.
type Standing = Liveness | 'retired'

const standingOf = (a: AgentProfile, now: number): Standing => (a.active ? liveness(a.lastSeen, now) : 'retired')

const GROUP_ORDER: readonly Standing[] = ['live', 'quiet', 'silent', 'retired']

const GROUP_TITLE: Record<Standing, string> = {
  live: 'На связи',
  quiet: 'Затихли',
  silent: 'Молчат',
  retired: 'Вне службы',
}

const GROUP_HINT: Record<Standing, string> = {
  live: 'отвечали в последние сутки — этим можно отдавать работу',
  quiet: 'сутки и дольше без единого действия',
  silent: 'неделю и дольше — считать, что работа у них идёт, нельзя',
  retired: 'работу не адресуем, записи и старые ветки остаются',
}

const LIVE_CLASS: Record<Liveness, string | undefined> = {
  live: s.live_live,
  quiet: s.live_quiet,
  silent: s.live_silent,
}

const CARD_CLASS: Record<Standing, string | undefined> = {
  live: undefined,
  quiet: s.card_quiet,
  silent: s.card_silent,
  retired: s.card_retired,
}

const SUM_DOT: Record<Liveness, string | undefined> = {
  live: s.dot_live,
  quiet: s.dot_quiet,
  silent: s.dot_silent,
}

/**
 * Агент, который так и не назвал себя, подписывается ИМЕНЕМ ДОСКИ — и выглядит на экране как коллега,
 * которым не является.
 *
 * Одного совпадения с именем проекта мало: агент вправе взять имя своей доски и при этом быть настоящим —
 * `erental` на доске «erental» именно такой. Признак поломки — совпадение И молчание о себе: без роли
 * доска и так не даёт ему передавать работу, так что это ровно тот случай, о котором надо сказать.
 */
function isUnclaimedBoardName(a: AgentProfile, boardNames: ReadonlySet<string>): boolean {
  return !a.role && boardNames.has(a.handle.trim().toLowerCase())
}

export default async function Roster() {
  if (!(await isAuthed())) redirect('/login')

  const now = Date.now()
  const agents = repo.listAgents()
  const projects = repo.listProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name] as const))
  const boardNames = new Set(projects.map((p) => p.name.trim().toLowerCase()))
  const all = repo.listReports({ archived: 'all', limit: TICKET_CEILING })
  const truncated = all.length === TICKET_CEILING

  const tallies = new Map<string, Tally>()
  const bump = (handle: string | null, key: keyof Tally): void => {
    if (!handle) return
    const t = tallies.get(handle) ?? emptyTally()
    t[key]++
    tallies.set(handle, t)
  }
  for (const r of all) {
    bump(r.creator, 'filed')
    if (r.archived) continue
    bump(r.assignee, 'addressed')
    // По одному разу на handle: тикет, где агент одновременно адресат и держатель, — это ОДИН тикет в списке,
    // который откроется по ссылке.
    for (const h of new Set(identitiesOf(r).filter((x): x is string => !!x))) {
      if (r.status === STATUS_NEEDS_REVIEW) bump(h, 'review')
      else if (r.status === STATUS_TAKEN) bump(h, 'working')
      else if (r.status === STATUS_REJECTED) bump(h, 'rework')
    }
  }

  // Каждый handle, который где-либо на доске говорит, и как часто. Авторы реплик читаются тикет за тикетом:
  // легаси-имена, которые владелец и ищет, подписывают РЕПЛИКИ куда чаще, чем тикеты, а одним запросом их
  // не достать. Экран открывают не на каждое обновление доски, поэтому цена платится там, где даёт ответ.
  const voices = new Map<string, Voice>()
  const heard = (handle: string | null, where: keyof Voice): void => {
    if (!handle) return
    const v = voices.get(handle) ?? emptyVoice()
    v[where]++
    voices.set(handle, v)
  }
  for (const r of all) for (const h of identitiesOf(r)) heard(h, 'tickets')
  // Голоса из обсуждений — ОДНИМ запросом, а не перебором комментариев каждого тикета: на живой доске это
  // было 380 запросов ради одного и того же ответа, и платил за них каждый вход на экран состава.
  for (const c of repo.commentAuthors(AGENT_VOICE)) heard(c.author, 'comments')
  const known = new Set(agents.map((a) => a.handle))
  const strangers = [...voices.entries()]
    .filter(([h]) => !known.has(h))
    .sort((a, b) => b[1].tickets + b[1].comments - (a[1].tickets + a[1].comments) || a[0].localeCompare(b[0]))

  const groups = GROUP_ORDER.map((key) => ({ key, rows: agents.filter((a) => standingOf(a, now) === key) }))
  const countOf = (key: Standing): number => groups.find((g) => g.key === key)?.rows.length ?? 0

  return (
    <Shell active="agents">
      <main className="wrap">
        <SectionHeader
          lead
          title="Агенты"
          hint="Кому можно отдать работу, кто её держит и кто замолчал"
          actions={
            <Link className="keyconnect" href={ROUTE_CONNECT}>
              ⇗ Подключить агента
            </Link>
          }
        />

        <p className={s.lead}>
          Роль — это то, что другой агент читает перед тем, как взять или передать сюда работу. Пока роль пуста,
          доска отказывает агенту в передаче (<b>role_required</b>), так что это не косметика. Имя и роль правятся
          прямо в карточке: щёлкните по строке и нажмите Enter.
        </p>

        {truncated ? (
          <div className={s.warn}>
            Счёт ведётся по последним {TICKET_CEILING} тикетам — на доске их больше, цифры ниже занижены.
          </div>
        ) : null}

        <div className={s.sum}>
          {(['live', 'quiet', 'silent'] as const).map((k) => (
            <span key={k} className={cx(s.sumitem, countOf(k) === 0 && s.sumitem_zero)} title={LIVENESS_HINT[k]}>
              <span className={cx(s.sumdot, SUM_DOT[k])} />
              <span className={s.sumn}>{countOf(k)}</span>
              {LIVENESS_LABEL[k]}
            </span>
          ))}
          <span className={cx(s.sumitem, countOf('retired') === 0 && s.sumitem_zero)} title={GROUP_HINT.retired}>
            <span className={s.sumn}>{countOf('retired')}</span>
            вне службы
          </span>
          {strangers.length ? (
            <span className={s.sumitem} title={UNKNOWN_HINT}>
              <span className={s.sumn}>{strangers.length}</span>
              имён вне состава
            </span>
          ) : null}
          <span className={s.sumsep} />
          <span className={s.sumnote}>
            Молчание считается от последнего ДЕЙСТВИЯ агента на доске, а не от того, что о нём написали.
          </span>
        </div>

        {agents.length === 0 ? (
          <EmptyState
            title="Состав пуст"
            hint="Агент появляется здесь сам, как только впервые что-то делает на доске. Чтобы это случилось, ему нужна одна команда подключения."
            actions={
              <Link className="keyconnect" href={ROUTE_CONNECT}>
                ⇗ Подключить агента
              </Link>
            }
          />
        ) : null}

        {groups.map(({ key, rows }) =>
          rows.length === 0 ? null : (
            <section className={s.group} key={key}>
              <SectionHeader title={GROUP_TITLE[key]} count={rows.length} countTone="quiet" hint={GROUP_HINT[key]} />
              <div className={s.cards}>
                {rows.map((a) => {
                  const t = tallies.get(a.handle) ?? emptyTally()
                  const live = liveness(a.lastSeen, now)
                  const boards = a.boards.map((id) => projName.get(id) ?? id)
                  const busy = t.working + t.rework
                  const impostor = isUnclaimedBoardName(a, boardNames)
                  return (
                    <article className={cx(s.card, CARD_CLASS[key])} key={a.handle}>
                      <div className={s.main}>
                        <div className={s.idline}>
                          <span className={s.handle}>{a.handle}</span>
                          <span
                            className={cx(s.live, LIVE_CLASS[live])}
                            title={`${LIVENESS_HINT[live]} · последнее действие ${exact(a.lastSeen)}`}
                          >
                            {LIVENESS_LABEL[live]} · {agoLong(a.lastSeen, now)}
                          </span>
                          {a.active ? null : <span className={s.mark}>в отставке</span>}
                        </div>

                        <AgentEditor
                          handle={a.handle}
                          title={a.title}
                          role={a.role}
                          active={a.active}
                          maxTitle={MAX_AGENT_TITLE_LEN}
                          maxRole={MAX_AGENT_ROLE_LEN}
                        />

                        {/* Реальное состояние доски, а не гипотеза. Диагноз один на карточку: «имя доски» уже
                            включает в себя «роль не описана», и повторять это второй плашкой значит учить
                            владельца пролистывать предупреждения. */}
                        {impostor ? (
                          <div className={s.flag}>
                            <b>Это имя доски, а не агента.</b> Так подписывается агент, который не назвал себя: роли
                            у него нет, передавать работу он не может (<code>role_required</code>). Чинится на его
                            стороне — <code>{ENV_AGENT}=его-имя</code> в MCP-сервере, затем перезапуск приложения
                            агента.{' '}
                            <Link className={s.flaglink} href={ROUTE_CONNECT}>
                              Как это сделать →
                            </Link>
                          </div>
                        ) : a.role ? null : (
                          <div className={s.flag}>
                            <b>Роль не описана.</b> Пока она пуста, этот агент не может передавать работу другим —
                            доска отвечает ему <code>role_required</code>, — а вы не видите, чем он занят.
                          </div>
                        )}

                        {/* Сочетание, ради которого экран и существует: он молчит, а работа на нём висит. */}
                        {key === 'silent' && busy > 0 ? (
                          <div className={cx(s.flag, s.flag_hard)}>
                            <b>
                              Молчит {ago(a.lastSeen, now)}, а в работе с его участием ещё {busy}.
                            </b>{' '}
                            Эта работа стоит: либо агента надо запустить заново, либо тикеты передать другому.
                          </div>
                        ) : null}

                        <div className={s.boards}>
                          <span className={s.boardsk}>доски</span>
                          {boards.length ? (
                            boards.map((b) => (
                              <span className={s.board} key={b}>
                                {b}
                              </span>
                            ))
                          ) : (
                            <span className={cx(s.board, s.board_none)}>ещё нигде не работал</span>
                          )}
                          <span className={s.since} title={`Впервые появился ${exact(a.firstSeen)}`}>
                            в составе с {new Date(a.firstSeen).toLocaleDateString('ru-RU')}
                          </span>
                        </div>
                      </div>

                      <div className={s.work}>
                        <Link
                          className={cx(s.stat, t.review ? s.stat_attention : s.stat_zero)}
                          href={boardHref({ view: VIEW_REVIEW, agent: a.handle })}
                          title="Сдано и ждёт вашего слова — принять или вернуть может только владелец"
                        >
                          <span className={s.statk}>ждут вашего слова</span>
                          <span className={s.statn}>{t.review}</span>
                        </Link>
                        <Link
                          className={cx(s.stat, !t.working && s.stat_zero)}
                          href={boardHref({ agent: a.handle, status: STATUS_TAKEN })}
                          title="Взято в работу и ещё не сдано"
                        >
                          <span className={s.statk}>в работе</span>
                          <span className={s.statn}>{t.working}</span>
                        </Link>
                        <Link
                          className={cx(s.stat, !t.rework && s.stat_zero)}
                          href={boardHref({ agent: a.handle, status: STATUS_REJECTED })}
                          title="Вы вернули на доработку — тикет снова на нём"
                        >
                          <span className={s.statk}>на доработке</span>
                          <span className={s.statn}>{t.rework}</span>
                        </Link>
                        <div className={s.workdiv} />
                        {/* Без ссылки намеренно: у доски нет фильтра «только адресованные» и «только поставленные»,
                            а ссылка, открывающая не то, что обещала цифра, хуже отсутствующей ссылки. */}
                        <span
                          className={cx(s.stat, !t.addressed && s.stat_zero)}
                          title="Адресовано этому агенту и ещё не в архиве"
                        >
                          <span className={s.statk}>адресовано ему</span>
                          <span className={s.statn}>{t.addressed}</span>
                        </span>
                        <span className={cx(s.stat, !t.filed && s.stat_zero)} title="Поставил сам, считая архив">
                          <span className={s.statk}>поставил</span>
                          <span className={s.statn}>{t.filed}</span>
                        </span>
                        <Link className={s.tolist} href={boardHref({ agent: a.handle })}>
                          Всё, к чему он причастен →
                        </Link>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ),
        )}

        {strangers.length ? (
          <section className={s.strangers}>
            <SectionHeader
              plain
              title="Имена вне состава"
              count={strangers.length}
              countTone="quiet"
              hint="есть на тикетах и в переписке, но передать им работу нельзя"
            />
            <p className={s.lead}>{UNKNOWN_HINT}</p>
            <div className={s.flag}>
              <b>Чинится на стороне агента:</b> <code>{ENV_AGENT}=его-имя</code> в его MCP-сервере, затем
              перезапуск приложения агента — MCP-серверы читаются один раз при старте.{' '}
              <Link className={s.flaglink} href={ROUTE_CONNECT}>
                Как это сделать →
              </Link>
            </div>
            <div className={s.strangerlist}>
              {strangers.map(([handle, v]) => {
                const body = (
                  <>
                    <span className={s.strangerh}>{handle}</span>
                    <span className={s.strangern}>тикетов: {v.tickets}</span>
                    <span className={s.strangern}>реплик: {v.comments}</span>
                  </>
                )
                // Выбрать на доске можно только имя, которое есть НА ТИКЕТАХ; живущее лишь в ветках открыло бы
                // пустой список, поэтому ссылкой не притворяется.
                return v.tickets ? (
                  <Link className={s.stranger} href={boardHref({ agent: handle })} key={handle}>
                    {body}
                  </Link>
                ) : (
                  <span className={s.stranger} key={handle}>
                    {body}
                  </span>
                )
              })}
            </div>
          </section>
        ) : null}
      </main>
    </Shell>
  )
}
