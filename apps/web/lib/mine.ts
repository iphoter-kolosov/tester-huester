import {
  repo,
  sameIdentity,
  IDENTITY_EXTENSION,
  IDENTITY_OWNER,
  STATUS_NEEDS_REVIEW,
  STATUS_NEW,
  STATUS_REJECTED,
  STATUS_TAKEN,
  type AgentProfile,
  type ChangeEvent,
  type Comment,
  type Report,
} from '@th/db'
import { liveness } from '@/lib/liveness'

// Что сейчас на ходу У ВЛАДЕЛЬЦА — вся выборка экрана «Мой ход» одним вызовом.
//
// Живёт отдельно от page.tsx намеренно: экран отвечает за то, КАК это показано, а вопрос «что считается
// застрявшим» — это правило, и оно должно читаться одним куском, с порогами и причинами рядом. Раскидай его
// по разметке — и через месяц никто не скажет, почему тикет попал в «застряло».

const DAY = 24 * 60 * 60 * 1000

/** Сколько тикет может лежать взятым, прежде чем «работа идёт» перестаёт быть разумным допущением. */
export const STUCK_TAKEN_MS = 3 * DAY
/** Сколько сданная работа ждёт приёмки, прежде чем это уже долг владельца, а не очередь. */
export const STUCK_REVIEW_MS = 2 * DAY

/**
 * Потолок выборки repo.listReports. Спросив ровно потолок и получив ровно потолок, отличить «столько и есть»
 * от «здесь запрос кончился» невозможно — поэтому он назван и проверяется явно (см. `truncated`).
 */
export const TICKET_CEILING = 1000

/** Сколько последних записей журнала просматривается ради ленты «что происходит». */
const FEED_WINDOW = 400
/** Сколько строк ленты показывается. Лента — это боковой взгляд, а не отчёт. */
export const FEED_LIMIT = 14

/** Статусы, в которых тикет ещё жив. Принятое и отклонённое ничьего хода не ждёт. */
export const OPEN_STATUSES: readonly string[] = [STATUS_NEW, STATUS_TAKEN, STATUS_NEEDS_REVIEW, STATUS_REJECTED]

export const isOpen = (r: Report): boolean => OPEN_STATUSES.includes(r.status)

/** С какого момента работа лежит в текущих руках: взята — с момента взятия, иначе — с постановки. */
export const heldSince = (r: Report): number => r.takenAt ?? r.createdAt

/** Тикет, сданный на приёмку, вместе с отчётом о работе, по которому владелец принимает решение. */
export type ReviewItem = {
  report: Report
  /** Последний отчёт о работе. null — работу сдали, не приложив проверки: это дефект, и его видно. */
  check: Comment | null
  /** Когда сдали (по отчёту, а если его нет — по постановке тикета). */
  since: number
}

/** Тикет, где последнее слово осталось за агентом: он что-то сказал и ждёт ответа. */
export type QuestionItem = {
  report: Report
  comment: Comment
}

export type StuckKind = 'taken' | 'review'

export type StuckItem = {
  report: Report
  kind: StuckKind
  /** С какого момента идёт отсчёт простоя. */
  since: number
}

export type FeedItem = {
  event: ChangeEvent
  /** Тикет события. null — тикет удалён; строка всё равно показывается, иначе журнал молча врёт о полноте. */
  report: Report | null
}

export type MineCounters = {
  /** Ждут его приёмки — единственная очередь, которую не может разобрать никто другой. */
  review: number
  /** Адресовано лично ему. */
  addressed: number
  /** Взято агентами в работу. */
  inWork: number
  /** Поставлено и никем не взято. */
  unclaimed: number
  stuck: number
  /** Агентов, не выходивших на связь сутки и больше. */
  quiet: number
}

/** Агент состава вместе с ответом на «сколько на нём сейчас висит» — это и есть «кому можно отдать». */
export type AgentLoad = {
  agent: AgentProfile
  /** Открытых тикетов, которые он держит или которые на него адресованы. */
  open: number
}

export type MineData = {
  reviews: ReviewItem[]
  questions: QuestionItem[]
  stuck: StuckItem[]
  counters: MineCounters
  agents: AgentLoad[]
  feed: FeedItem[]
  /** Выборка упёрлась в потолок — значит цифры ЗАНИЖЕНЫ, и говорить их как факт нельзя. */
  truncated: boolean
}

/**
 * Состав, из которого владелец выбирает исполнителя.
 *
 * `owner` и `extension` — записи состава, но не адресаты: первый и есть тот, кто смотрит на экран, второй —
 * расширение, которым тикеты СНИМАЮТ, а не выполняют. В списке «кому отдать» они занимали бы две строки из
 * восьми и превращали бы вопрос «кто на связи» в загадку.
 */
const isAssignableAgent = (a: AgentProfile): boolean =>
  !sameIdentity(a.handle, IDENTITY_OWNER) && !sameIdentity(a.handle, IDENTITY_EXTENSION)

export function collectMine(now: number = Date.now()): MineData {
  const active = repo.listReports({ archived: false, limit: TICKET_CEILING })
  const open = active.filter(isOpen)

  // ── очередь приёмки. Сортировка — от самого старого: очередь разбирают снизу списка, а не сверху ленты.
  const reviews: ReviewItem[] = active
    .filter((r) => r.status === STATUS_NEEDS_REVIEW)
    .map((report) => {
      const check = repo.latestVerification(report.id)
      return { report, check, since: check?.createdAt ?? report.createdAt }
    })
    .sort((a, b) => a.since - b.since)

  // ── вопросы. Тикеты очереди приёмки сюда не попадают: там последнее слово агента — это и есть отчёт о
  // работе, он показан выше целиком, и дублировать его строкой «агент что-то написал» значит удвоить экран.
  const questions: QuestionItem[] = []
  for (const report of open) {
    if (report.status === STATUS_NEEDS_REVIEW) continue
    const thread = repo.listComments(report.id)
    const last = thread[thread.length - 1]
    if (last && last.authorKind === 'agent') questions.push({ report, comment: last })
  }
  questions.sort((a, b) => b.comment.createdAt - a.comment.createdAt)

  // ── застряло: чужая работа, которая не вернулась, и его собственная очередь, которую он не разобрал.
  const stuck: StuckItem[] = []
  for (const report of open) {
    if (report.status === STATUS_TAKEN) {
      const since = heldSince(report)
      if (now - since >= STUCK_TAKEN_MS) stuck.push({ report, kind: 'taken', since })
    }
  }
  for (const item of reviews) {
    if (now - item.since >= STUCK_REVIEW_MS) stuck.push({ report: item.report, kind: 'review', since: item.since })
  }
  stuck.sort((a, b) => a.since - b.since)

  // ── состав. Нагрузка считается по ОТКРЫТЫМ тикетам: сколько всего агент сделал за год — не ответ на вопрос
  // «можно ли ему сейчас дать ещё один».
  const roster = repo.listAgents().filter(isAssignableAgent)
  const load = new Map<string, number>()
  for (const r of open) {
    for (const h of new Set([r.takenBy, r.assignee].filter((h): h is string => !!h))) {
      load.set(h, (load.get(h) ?? 0) + 1)
    }
  }
  const agents: AgentLoad[] = roster
    .map((agent) => ({ agent, open: load.get(agent.handle) ?? 0 }))
    .sort((a, b) => {
      // Сначала те, кому вообще можно отдать: живые выше молчащих, выведенные из состава — в конце.
      const rank = (x: AgentLoad) => (x.agent.active ? 0 : 1)
      return rank(a) - rank(b) || b.agent.lastSeen - a.agent.lastSeen
    })

  // ── лента. seq в журнале сквозной по всем проектам, поэтому окно берётся от общего максимума: так «последние
  // 400 событий» — это действительно последние по доске, а не по каждому проекту отдельно.
  const projects = repo.listProjects()
  const maxSeq = projects.reduce((m, p) => Math.max(m, repo.latestSeq(p.id)), 0)
  const since = Math.max(0, maxSeq - FEED_WINDOW)
  const events = projects.flatMap((p) => repo.eventsSince(p.id, since, FEED_WINDOW))
  events.sort((a, b) => b.seq - a.seq)
  const feed: FeedItem[] = events.slice(0, FEED_LIMIT).map((event) => ({
    event,
    report: repo.getReport(event.reportId),
  }))

  const counters: MineCounters = {
    review: reviews.length,
    addressed: open.filter((r) => sameIdentity(r.assignee, IDENTITY_OWNER)).length,
    inWork: open.filter((r) => r.status === STATUS_TAKEN).length,
    unclaimed: open.filter((r) => r.status === STATUS_NEW && !r.assignee).length,
    stuck: stuck.length,
    quiet: roster.filter((a) => a.active && liveness(a.lastSeen, now) !== 'live').length,
  }

  return { reviews, questions, stuck, counters, agents, feed, truncated: active.length >= TICKET_CEILING }
}
