import Link from 'next/link'
import { redirect } from 'next/navigation'
import { repo, IDENTITY_EXTENSION } from '@th/db'
import Shell from '@/components/shell/Shell'
import SectionHeader from '@/components/ui/SectionHeader'
import EmptyState from '@/components/ui/EmptyState'
import StatusPill from '@/components/ui/StatusPill'
import { AgentRef, rosterMap, type RosterMap } from '@/components/agents'
import { ST_NEEDS_REVIEW, ST_TAKEN } from '@/components/status'
import { ROUTE_AGENTS, ROUTE_CONNECT, ROUTE_TICKETS } from '@/components/shell/nav'
import { LIVENESS_HINT, LIVENESS_LABEL, type Liveness } from '@/lib/liveness'
import { isAuthed } from '@/lib/auth'
import { ago, agoLong, exact } from '@/lib/time'
import { cx } from '@/lib/cx'
import { collectStats, humanDur, FLOW_DAYS, STUCK_TAKEN_MS, STUCK_REVIEW_MS, type AgentRow } from '@/lib/stats'
import { FlowChart, StatusDwellBars, ProjectBars } from './charts'
import s from './stats.module.css'

export const dynamic = 'force-dynamic'

// СТАТИСТИКА — накопленная работа доски под четыре вопроса владельца: здоровы ли агенты, где заторы, как идёт
// поток и что не так с самой системой прямо сейчас. Экран только ПОКАЗЫВАЕТ; всё, что считается — в lib/stats.
//
// Цвета внимания здесь нет намеренно: фиолетовый занят очередью приёмки на «Моём ходе». Проблема здоровья
// говорит предупреждением (жёлтый) или ошибкой (красный), норма — зелёным.

const DAY_MS = 24 * 60 * 60 * 1000
const days = (ms: number): number => Math.round(ms / DAY_MS)
/** Сколько строк показывает список, прежде чем отправить читать остальное на доску. */
const LIST_LIMIT = 12

/** Безымянные actor'ы: канал расширения и пустышки. Это НЕ агенты — рисуются как канал, а не как личность. */
const UNNAMED = new Set<string>([IDENTITY_EXTENSION, '', 'none', 'null', 'undefined'])

const LIVE_CLASS: Record<Liveness, string | undefined> = {
  live: s.live_live,
  quiet: s.live_quiet,
  silent: s.live_silent,
}
const ROW_CLASS: Record<Liveness, string | undefined> = {
  live: undefined,
  quiet: s.row_quiet,
  silent: s.row_silent,
}

/** Числовая ячейка: ноль тише единицы, пустая колонка не выглядит как работа. */
function Num({ n, strong }: { n: number; strong?: boolean }) {
  return <td className={cx(s.num, n === 0 && s.num0, strong && s.holdn)}>{n}</td>
}

/** Первая ячейка строки агента: агент состава как личность, безымянный actor — как канал. */
function ActorCell({ row, roster }: { row: AgentRow; roster: RosterMap }) {
  if (UNNAMED.has(row.agent)) {
    return (
      <span className={s.channel} title="Канал захвата расширением — тикеты СНИМАЮТ им, а не выполняют. Не агент.">
        <span className={s.channelh}>{row.agent || '—'}</span>
        <span className={s.channelmark}>канал</span>
      </span>
    )
  }
  return <AgentRef handle={row.agent} roster={roster} nobody="—" />
}

export default async function Stats() {
  if (!(await isAuthed())) redirect('/login')

  const now = Date.now()
  const d = collectStats(now)
  const roster: RosterMap = rosterMap(repo.listAgents())
  const sys = d.system

  const stuckTotal = d.stuckTaken + d.stuckReview
  const journalPct = sys.journalSize ? Math.round((sys.unnamedActorEvents / sys.journalSize) * 100) : 0

  // Пульс системы: числа-ссылки. state красит только проблему; ноль проблемного метрика — спокойный (хорошая новость).
  type Tile = { key: string; n: number; label: string; sub?: string; href: string; state: 'neutral' | 'warn' | 'bad' }
  const tiles: Tile[] = [
    { key: 'journal', n: sys.journalSize, label: 'событий в журнале', sub: `+${sys.growth7d} за неделю`, href: '#system', state: 'neutral' },
    { key: 'live', n: sys.liveSessions, label: 'живых сессий', sub: `${sys.collisions} коллизий имён`, href: ROUTE_AGENTS, state: 'neutral' },
    { key: 'collisions', n: sys.collisions, label: 'коллизий имён', sub: 'одно имя — несколько процессов', href: '#system', state: 'bad' },
    { key: 'stuck', n: stuckTotal, label: 'застряло', sub: `взято >${days(STUCK_TAKEN_MS)}дн / ждёт >${days(STUCK_REVIEW_MS)}дн`, href: '#friction', state: 'warn' },
    { key: 'orphans', n: d.orphans.length, label: 'тикетов-сирот', sub: 'ничьи и не закрыты', href: '#friction', state: 'warn' },
    { key: 'silent', n: sys.silentAgents, label: 'агентов молчит', sub: `дольше ${days(24 * 60 * 60 * 1000)} сут`, href: ROUTE_AGENTS, state: 'warn' },
    { key: 'cross', n: sys.crossBoard.length, label: 'чужих адресаций', sub: 'отдано не на свою доску', href: '#system', state: 'bad' },
  ]

  return (
    <Shell active="stats">
      <main className="wrap">
        <SectionHeader
          lead
          plain
          title="Статистика"
          hint="Накопленная работа доски: агенты, заторы, поток и здоровье системы"
          actions={<Link className={s.open} href={ROUTE_TICKETS}>вся доска →</Link>}
        />

        {d.truncated ? (
          <p className={s.warn}>
            Тикетов больше, чем экран берёт за один заход, — цифры ниже ЗАНИЖЕНЫ. Это предел выборки, а не
            реальный потолок доски.
          </p>
        ) : null}

        <div className={s.pulse}>
          {tiles.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={cx(
                s.tile,
                t.state === 'warn' && t.n > 0 && s.tile_warn,
                t.state === 'bad' && t.n > 0 && s.tile_bad,
                t.n === 0 && s.tile_zero,
              )}
            >
              <span className={s.tilen}>{t.n}</span>
              <span className={s.tilelbl}>{t.label}</span>
              {t.sub ? <span className={s.tilesub}>{t.sub}</span> : null}
            </Link>
          ))}
        </div>

        {/* ── ЛИНЗА 1: здоровье агентов ─────────────────────────────────────────────────────────────────── */}
        <section id="agents" className={s.section}>
          <SectionHeader
            title="Здоровье агентов"
            count={d.agents.length}
            countTone="quiet"
            countTitle="Столько имён действовало на доске"
            hint="сверху — кто несёт больше живой нагрузки; молчание видно по строке"
          />
          {d.agents.length === 0 ? (
            <EmptyState
              title="На доске ещё никто не действовал"
              hint="Как только агент поставит тикет, возьмёт работу или сменит статус, он появится здесь со своими числами."
              actions={<Link className={s.open} href={ROUTE_CONNECT}>Подключить агента</Link>}
            />
          ) : (
            <div className={s.tablewrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>агент</th>
                    <th title="Поставил тикетов">завёл</th>
                    <th title="Взял в работу">взял</th>
                    <th title="Сдал на проверку">сдал</th>
                    <th title="Принял работу (только заказчик или владелец)">принято</th>
                    <th title="Вернул на доработку">возвращено</th>
                    <th title="Держит открытых тикетов прямо сейчас">держит</th>
                    <th title="Среднее от взятия им тикета до его приёмки">ср. до приёмки</th>
                    <th>активность</th>
                  </tr>
                </thead>
                <tbody>
                  {d.agents.map((a) => (
                    <tr key={a.agent} className={ROW_CLASS[a.liveness]}>
                      <td className={s.agentcell}><ActorCell row={a} roster={roster} /></td>
                      <Num n={a.filed} />
                      <Num n={a.taken} />
                      <Num n={a.handedToReview} />
                      <Num n={a.accepted} />
                      <Num n={a.rejected} />
                      <Num n={a.holding} strong />
                      <td className={s.num}>
                        {a.avgToAcceptMs === null ? (
                          <span className={s.dash} title="Принятых им тикетов ещё нет">—</span>
                        ) : (
                          humanDur(a.avgToAcceptMs)
                        )}
                      </td>
                      <td>
                        <span className={s.actcell}>
                          <span className={cx(s.livepill, LIVE_CLASS[a.liveness])} title={LIVENESS_HINT[a.liveness]}>
                            {LIVENESS_LABEL[a.liveness]}
                          </span>
                          {a.lastEventAt === null ? (
                            <span className={s.actwhen}>—</span>
                          ) : (
                            <span className={s.actwhen} title={exact(a.lastEventAt)}>{agoLong(a.lastEventAt, now)}</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── ЛИНЗА 2: заторы и трение ──────────────────────────────────────────────────────────────────── */}
        <section id="friction" className={s.section}>
          <SectionHeader
            title="Заторы и трение"
            hint="где работа стоит, что возвращают чаще всего и какие тикеты не адресованы никому"
          />

          <div className={s.grid2}>
            <div className={s.card}>
              <p className={s.cardttl}>Сколько тикет ждёт в каждом статусе</p>
              <div className={s.stuckchips}>
                <Link className={cx(s.chip, d.stuckTaken > 0 && s.chip_hot)} href={`${ROUTE_TICKETS}?status=${ST_TAKEN}`}>
                  <span className={s.chipn}>{d.stuckTaken}</span> взято дольше {days(STUCK_TAKEN_MS)} дн
                </Link>
                <Link className={cx(s.chip, d.stuckReview > 0 && s.chip_hot)} href={`${ROUTE_TICKETS}?status=${ST_NEEDS_REVIEW}`}>
                  <span className={s.chipn}>{d.stuckReview}</span> ждёт приёмки дольше {days(STUCK_REVIEW_MS)} дн
                </Link>
              </div>
              {d.dwell.length === 0 ? (
                <p className={s.sub}>Переходов статусов ещё не было — среднее время считать не по чему.</p>
              ) : (
                <>
                  <StatusDwellBars dwell={d.dwell} />
                  <p className={s.more}>среднее по завершённым переходам · справа — число переходов, по которым посчитано</p>
                </>
              )}
            </div>

            <div className={s.card}>
              <p className={s.cardttl}>Что возвращают чаще всего</p>
              {d.bounced.length === 0 ? (
                <p className={s.sub}>Ничего не возвращали — сданная работа проходит с первого раза.</p>
              ) : (
                <>
                  <ul className={s.list}>
                    {d.bounced.slice(0, LIST_LIMIT).map((b) => (
                      <li className={s.listrow} key={b.id}>
                        <span className={s.rejbadge} title={`возвращали ${b.rejections} раз`}>×{b.rejections}</span>
                        <Link className={s.listnote} href={`/r/${b.id}`}>
                          {b.note || <span className={s.nonote}>без заметки</span>}
                        </Link>
                        <StatusPill status={b.status} size="sm" />
                      </li>
                    ))}
                  </ul>
                  {d.bounced.length > LIST_LIMIT ? (
                    <p className={s.more}>показаны {LIST_LIMIT} из {d.bounced.length} — самые возвращаемые</p>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className={s.subsection}>
            <SectionHeader
              title="Осиротевшие тикеты"
              count={d.orphans.length}
              countTone="quiet"
              countTitle="Не адресованы никому и ещё не закрыты"
              hint="никто не назначен, статус не «принято» и не «не делаем» — та стопка, которую с доски было не видно"
            />
            {d.orphans.length === 0 ? (
              <EmptyState
                title="Сирот нет"
                hint="Каждый живой тикет либо кому-то адресован, либо уже закрыт. Работа не теряется в ничьей стопке."
              />
            ) : (
              <ul className={s.list}>
                {d.orphans.slice(0, LIST_LIMIT).map((o) => {
                  const hot = o.ageMs >= STUCK_TAKEN_MS
                  return (
                    <li className={s.listrow} key={o.id}>
                      <span className={s.listtid}>#{o.shortId}</span>
                      <Link className={s.listnote} href={`/r/${o.id}`}>
                        {o.note || <span className={s.nonote}>без заметки</span>}
                      </Link>
                      <StatusPill status={o.status} size="sm" />
                      <span className={cx(s.age, hot && s.age_hot)} title={exact(o.createdAt)}>{humanDur(o.ageMs)}</span>
                    </li>
                  )
                })}
              </ul>
            )}
            {d.orphans.length > LIST_LIMIT ? (
              <p className={s.more}>показаны {LIST_LIMIT} из {d.orphans.length} — самые старые сверху</p>
            ) : null}
          </div>
        </section>

        {/* ── ЛИНЗА 3: поток во времени ─────────────────────────────────────────────────────────────────── */}
        <section id="flow" className={s.section}>
          <SectionHeader title="Поток во времени" hint={`заведено против принятого за последние ${FLOW_DAYS} дней`} />
          {d.flow.length === 0 ? (
            <EmptyState
              title={`За ${FLOW_DAYS} дней потока не было`}
              hint="Ни одного заведённого или принятого тикета в этом окне. Как только пойдёт работа — здесь появятся столбики."
            />
          ) : (
            <div className={s.card}>
              <FlowChart flow={d.flow} days={FLOW_DAYS} />
            </div>
          )}

          {d.projectFlow.length > 1 ? (
            <div className={cx(s.card, s.stack)}>
              <p className={s.cardttl}>По проектам</p>
              <ProjectBars rows={d.projectFlow} days={FLOW_DAYS} />
            </div>
          ) : null}
        </section>

        {/* ── ЛИНЗА 4: здоровье системы ─────────────────────────────────────────────────────────────────── */}
        <section id="system" className={s.section}>
          <SectionHeader
            title="Здоровье системы"
            hint="что не так с самой доской прямо сейчас — каждая строка это число и, где можно, ссылка починить"
          />
          <div className={s.checklist}>
            {/* Коллизии имён — проблема №1: одно имя подписывают несколько процессов, и чей ход — не видно. */}
            <div className={cx(s.check, sys.collisions > 0 && s.check_bad)}>
              <span className={s.checkn}>{sys.collisions}</span>
              <div className={s.checkbody}>
                <p className={s.checkttl}>Коллизии имён</p>
                <p className={s.checkhint}>Одно имя подписывают несколько живых сессий — чей ход, с доски не отличить.</p>
                {sys.collisions === 0 ? (
                  <p className={s.checkok}>каждое живое имя — один процесс</p>
                ) : (
                  <div className={s.checkdetail}>
                    {sys.collisionGroups.map((g) => (
                      <div key={g.agent}>
                        <span className={s.handletag}>{g.agent}</span> — {g.count} процесса
                        <ul className={s.sesslist}>
                          {g.sessions.map((se) => (
                            <li className={s.sessrow} key={se.sessionId}>
                              <span className={s.sessorigin}>{se.origin || se.sessionId.slice(0, 8)}</span>
                              <span className={s.sesswhen}>{ago(se.lastSeen, now)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    <Link className={s.open} href={ROUTE_AGENTS}>состав →</Link>
                  </div>
                )}
              </div>
            </div>

            {/* Перекрёстная адресация: тикет отдан агенту не с этой доски — он его не увидит в своём инбоксе. */}
            <div className={cx(s.check, sys.crossBoard.length > 0 && s.check_bad)}>
              <span className={s.checkn}>{sys.crossBoard.length}</span>
              <div className={s.checkbody}>
                <p className={s.checkttl}>Чужая адресация</p>
                <p className={s.checkhint}>Открытые тикеты, отданные агенту, который эту доску не работает.</p>
                {sys.crossBoard.length === 0 ? (
                  <p className={s.checkok}>все адресаты работают свою доску</p>
                ) : (
                  <div className={s.checkdetail}>
                    {sys.crossBoard.slice(0, LIST_LIMIT).map((c) => (
                      <div className={s.crossrow} key={c.id}>
                        <Link className={s.listtid} href={`/r/${c.id}`}>#{c.shortId}</Link>
                        <span className={s.crossto}>отдан <b>{c.assignee}</b> · доска {c.board}</span>
                      </div>
                    ))}
                    {sys.crossBoard.length > LIST_LIMIT ? (
                      <p className={s.more}>и ещё {sys.crossBoard.length - LIST_LIMIT}</p>
                    ) : null}
                  </div>
                )}
              </div>
            </div>

            {/* Молчащие агенты: числятся в составе, но давно не выходили — рассчитывать на них нельзя. */}
            <div className={cx(s.check, sys.silentAgents > 0 && s.check_warn)}>
              <span className={s.checkn}>{sys.silentAgents}</span>
              <div className={s.checkbody}>
                <p className={s.checkttl}>Молчащие агенты</p>
                <p className={s.checkhint}>Активны в составе, но дольше суток не выходили на связь.</p>
                {sys.silentAgents === 0 ? (
                  <p className={s.checkok}>весь активный состав на связи</p>
                ) : (
                  <div className={s.checkdetail}>
                    <div className={s.handlelist}>
                      {sys.silentAgentHandles.map((h) => <span className={s.handletag} key={h}>{h}</span>)}
                    </div>
                    <p className={s.more}><Link className={s.open} href={ROUTE_AGENTS}>состав →</Link></p>
                  </div>
                )}
              </div>
            </div>

            {/* Безымянные записи: журнал, который нельзя приписать никому в составе (канал расширения, пустышки). */}
            <div className={s.check}>
              <span className={s.checkn}>{sys.unnamedActorEvents}</span>
              <div className={s.checkbody}>
                <p className={s.checkttl}>Безымянные записи</p>
                <p className={s.checkhint}>
                  Событий журнала без looked-up-агента — это {journalPct}% журнала. Захваты расширением и легаси
                  без имени; новые захваты уже пишутся на владельца.
                </p>
              </div>
            </div>

            {/* Сессии: живые сейчас и недавно замолчавшие (возможные забытые форки). */}
            <div className={cx(s.check, sys.recentlySilentSessions > 0 && s.check_warn)}>
              <span className={s.checkn}>{sys.liveSessions}</span>
              <div className={s.checkbody}>
                <p className={s.checkttl}>Живые сессии</p>
                <p className={s.checkhint}>
                  Процессов на связи в последние минуты.
                  {sys.recentlySilentSessions > 0
                    ? ` Ещё ${sys.recentlySilentSessions} писали за сутки, но сейчас молчат — возможно, забытые форки.`
                    : ' Недавно замолчавших сессий нет.'}
                </p>
              </div>
            </div>

            {/* Рост журнала: не только размер, но и темп — чтобы видеть, живёт доска или встала. */}
            <div className={s.check}>
              <span className={s.checkn}>{sys.growth24h}</span>
              <div className={s.checkbody}>
                <p className={s.checkttl}>Событий за сутки</p>
                <p className={s.checkhint}>
                  За неделю — {sys.growth7d}. Всего в журнале {sys.journalSize}. Темп показывает, идёт работа
                  или доска встала.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Shell>
  )
}
