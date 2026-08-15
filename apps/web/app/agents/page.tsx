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
import { NO_ROLE, UNKNOWN_HINT } from '@/components/agents'
import { isAuthed } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// repo.listReports refuses to return more than this. Asked for exactly the ceiling and given exactly the ceiling,
// the page cannot tell "that is all of them" from "that is where the query stopped" — so it says so out loud
// instead of quietly printing counts that are short.
const TICKET_CEILING = 1000

// Comments written by the owner carry a display name, not an identity; only agent voices are roster handles.
const AGENT_VOICE: AuthorKind = 'agent'

// A silent agent looks exactly like a working one, which is the whole problem: nothing about a stalled worker is
// visible until somebody wonders why a ticket never moved. A day of quiet is ordinary between sessions; a week is
// the point where "still running" stops being a reasonable assumption and the owner has to be told.
const QUIET_AFTER_MS = 24 * 60 * 60 * 1000
const SILENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000

type Liveness = 'live' | 'quiet' | 'silent'

function liveness(lastSeen: number): Liveness {
  const idle = Date.now() - lastSeen
  if (idle >= SILENT_AFTER_MS) return 'silent'
  if (idle >= QUIET_AFTER_MS) return 'quiet'
  return 'live'
}

const LIVENESS_WORD: Record<Liveness, string> = { live: 'на связи', quiet: 'тихо', silent: 'молчит' }

function ago(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'только что'
  if (mins < 60) return `${mins} мин назад`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.floor(h / 24)} дн назад`
}

// What each agent is carrying. `filed` counts the archive too — authorship does not expire — while the three
// live columns do not: work that has been filed away is nobody's plate any more.
type Tally = { filed: number; addressed: number; holds: number; review: number }
const emptyTally = (): Tally => ({ filed: 0, addressed: 0, holds: 0, review: 0 })

const identitiesOf = (r: Report): (string | null)[] => [r.creator, r.assignee, r.takenBy]

// Where a handle was heard. The board can only be filtered by the ticket half, so the two are never added up.
type Voice = { tickets: number; comments: number }
const emptyVoice = (): Voice => ({ tickets: 0, comments: 0 })

export default async function Roster() {
  if (!(await isAuthed())) redirect('/login')

  const agents = repo.listAgents()
  const projName = new Map(repo.listProjects().map((p) => [p.id, p.name] as const))
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
    // A ticket sent back for rework is still on the plate of whoever took it — «в работе» means "waiting on this
    // agent", not "the status literally says taken".
    if (r.status === STATUS_TAKEN || r.status === STATUS_REJECTED) bump(r.takenBy, 'holds')
    if (r.status === STATUS_NEEDS_REVIEW) bump(r.takenBy, 'review')
  }

  // Every handle that speaks anywhere on this board, and how often. Comment authors are read ticket by ticket
  // because the legacy names the owner is looking for — the board names — sign COMMENTS far more often than they
  // sign tickets, and there is no single query for them. This page is owner-only and read on purpose, not on
  // every board refresh, so the cost is paid where it buys the answer.
  // Counted apart, because only the ticket half is reachable from the board filter — and a name that exists ONLY
  // in threads is the purest form of the defect: a voice that talks and holds nothing.
  const voices = new Map<string, Voice>()
  const heard = (handle: string | null, where: keyof Voice): void => {
    if (!handle) return
    const v = voices.get(handle) ?? emptyVoice()
    v[where]++
    voices.set(handle, v)
  }
  for (const r of all) {
    for (const h of identitiesOf(r)) heard(h, 'tickets')
    for (const c of repo.listComments(r.id)) if (c.authorKind === AGENT_VOICE) heard(c.author, 'comments')
  }
  const known = new Set(agents.map((a) => a.handle))
  const strangers = [...voices.entries()]
    .filter(([h]) => !known.has(h))
    .sort((a, b) => b[1].tickets + b[1].comments - (a[1].tickets + a[1].comments) || a[0].localeCompare(b[0]))

  const boardsOf = (a: AgentProfile): string[] => a.boards.map((id) => projName.get(id) ?? id)

  return (
    <main className="wrap">
      <Link className="back" href="/">← все тикеты</Link>
      <div className="h" style={{ marginTop: 10 }}>
        <span className="h1">Состав</span>
        {/* «в составе: N», not «N агентов»: the counts here are whatever the board happens to hold, and a Russian
            numeral would have to agree with each of them. A label and a number always agree. */}
        <span className="c">в составе: {agents.length}{strangers.length ? ` · вне состава: ${strangers.length}` : ''}</span>
      </div>
      <p className="rosterlead">
        Кто работает эту доску и чем занимается. Роль — это то, что другой агент читает перед тем, как адресовать
        сюда работу: пишите, что агент делает и за что отвечает. Имя и роль правятся прямо здесь.
      </p>
      {truncated ? (
        <div className="rosterwarn">
          Счёт ведётся по последним {TICKET_CEILING} тикетам — на доске их больше, цифры ниже занижены.
        </div>
      ) : null}

      {agents.map((a) => {
        const t = tallies.get(a.handle) ?? emptyTally()
        const state = liveness(a.lastSeen)
        const boards = boardsOf(a)
        return (
          <section className={'agcard ag-' + state + (a.active ? '' : ' ag-retired')} key={a.handle}>
            <div className="aghead">
              <span className="aghandlebig">{a.handle}</span>
              <span className={'aglive aglive-' + state} title={`Последнее действие: ${new Date(a.lastSeen).toLocaleString()}`}>
                {LIVENESS_WORD[state]} · {ago(a.lastSeen)}
              </span>
              {a.active ? null : <span className="agoff">в отставке</span>}
              <Link className="agtoboard" href={`/?agent=${encodeURIComponent(a.handle)}`}>Показать на доске →</Link>
            </div>

            {a.role ? null : <div className="agnorole">{NO_ROLE} — впишите, иначе агенты будут адресовать работу вслепую</div>}

            <AgentEditor
              handle={a.handle}
              title={a.title}
              role={a.role}
              active={a.active}
              maxTitle={MAX_AGENT_TITLE_LEN}
              maxRole={MAX_AGENT_ROLE_LEN}
            />

            <div className="agstats">
              <span className="agstat" title="Поставил тикетов, включая архив">
                поставил <b>{t.filed}</b>
              </span>
              <span className={'agstat' + (t.addressed ? '' : ' agstat-zero')} title="Адресовано этому агенту (без архива)">
                адресовано <b>{t.addressed}</b>
              </span>
              <span className="agstat" title="Взял и ещё не сдал — считая возвращённые на доработку">
                в работе <b>{t.holds}</b>
              </span>
              <span className={'agstat' + (t.review ? ' agstat-review' : '')} title="Сдал и ждёт вашего слова">
                ждут проверки <b>{t.review}</b>
              </span>
              <span className="agstat agstat-soft" title={`Впервые появился ${new Date(a.firstSeen).toLocaleString()}`}>
                с {new Date(a.firstSeen).toLocaleDateString()}
              </span>
            </div>

            <div className="agboards">
              <span className="agboardsk">доски</span>
              {boards.length ? (
                boards.map((b) => <span className="agboard" key={b}>{b}</span>)
              ) : (
                <span className="agboard agboard-none">ещё нигде не работал</span>
              )}
            </div>
          </section>
        )
      })}

      {strangers.length ? (
        <section className="strangers">
          <div className="strangershead">
            <span className="ctxttl">Имена вне состава</span>
            <span className="thrn">{strangers.length}</span>
          </div>
          <p className="strangerslead">{UNKNOWN_HINT}</p>
          <div className="strangerlist">
            {strangers.map(([handle, v]) => {
              const counts = (
                <>
                  <span className="aghandle">{handle}</span>
                  <span className="strangern">тикетов: {v.tickets}</span>
                  <span className="strangern">реплик: {v.comments}</span>
                </>
              )
              // Only a name that is ON tickets can be selected on the board; one that exists solely in threads
              // would land on an empty list, so it is not offered as a link at all.
              return v.tickets ? (
                <Link className="stranger" href={`/?agent=${encodeURIComponent(handle)}`} key={handle}>{counts}</Link>
              ) : (
                <span className="stranger stranger-flat" key={handle}>{counts}</span>
              )
            })}
          </div>
        </section>
      ) : null}
    </main>
  )
}
