import {
  repo,
  normalizeIdentity,
  STATUSES,
  STATUS_NEW,
  STATUS_TAKEN,
  STATUS_NEEDS_REVIEW,
  STATUS_REJECTED,
  STATUS_VERIFIED,
  SESSION_LIVE_MS,
  SILENT_AGENT_MS,
  type AgentActivity,
  type AgentProfile,
  type AgentSession,
  type ChangeEvent,
  type FlowDay,
  type Orphan,
  type Report,
  type SessionGroup,
  type Status,
  type SystemHealth,
} from '@th/db'
import { liveness, type Liveness } from '@/lib/liveness'

// Данные экрана «Статистика» — четыре линзы (агенты, заторы, поток, здоровье системы) одним чтением.
//
// Правило файла: считать здесь, показывать — в page.tsx. Экран отвечает за то, КАК выглядит цифра; вопрос
// «что она значит» (какой тикет застрял, чьё время до приёмки, что считается перекрёстной адресацией) — это
// правило, и оно должно читаться одним куском, а не собираться из разметки. Готовые агрегаты берём у ядра
// (repo.agentActivity/flowByDay/orphans/systemHealth/sessionsByAgent); то, для чего у ядра метода нет —
// среднее время в статусе, время до приёмки, перекрёстная адресация — строим здесь по журналу и составу.

const DAY_MS = 24 * 60 * 60 * 1000

/** Окно графика потока: столько последних дней рисуем created vs verified. */
export const FLOW_DAYS = 30
/** Взято дольше этого — «работа идёт» перестаёт быть разумным допущением (то же число, что на «Моём ходе»). */
export const STUCK_TAKEN_MS = 3 * DAY_MS
/** Сдано и ждёт приёмки дольше этого — уже долг владельца, а не очередь. */
export const STUCK_REVIEW_MS = 2 * DAY_MS

/**
 * Потолок выборки reports/событий. Спросив ровно потолок и получив ровно потолок, отличить «столько и есть»
 * от «здесь запрос кончился» невозможно — поэтому он назван и проверяется явно (см. `truncated`).
 */
export const TICKET_CEILING = 1000
/** Размер страницы дочитывания журнала. repo.eventsSince жёстко режет отдачу на 500 — читаем по 500 и до конца. */
const EVENT_PAGE = 500

/** Транзитные статусы, для которых «сколько тикет в них проводит» имеет смысл. Принятое и «не делаем» — конечные. */
const TRANSIENT_STATUSES: readonly Status[] = [STATUS_NEW, STATUS_TAKEN, STATUS_NEEDS_REVIEW, STATUS_REJECTED]

// ── строка таблицы «здоровье агентов» ────────────────────────────────────────────────────────────────────
// Агрегат ядра (завёл/взял/сдал/принято/возвращено/держит/последняя активность) плюс то, чего в нём нет:
// связан ли этот actor с реальным агентом состава, жив ли он и сколько в среднем идёт от взятия его работы
// до её приёмки.
export type AgentRow = AgentActivity & {
  /** Профиль состава, если этот actor — зарегистрированный агент. null — это канал (расширение) или имя вне состава. */
  profile: AgentProfile | null
  /** Живость: по last_seen состава, если агент известен, иначе — по последнему действию в журнале. */
  liveness: Liveness
  /** Среднее время от взятия тикета этим агентом до его приёмки. null — принятых им тикетов нет. */
  avgToAcceptMs: number | null
}

// ── средняя длительность одного статуса по доске ─────────────────────────────────────────────────────────
export type StatusDwell = {
  status: Status
  avgMs: number
  /** По скольким ЗАВЕРШЁННЫМ переходам посчитано (тикет уже ушёл из статуса) — иначе среднее врёт о неоконченном. */
  intervals: number
}

// ── тикет, который возвращали ────────────────────────────────────────────────────────────────────────────
export type Bounced = {
  id: string
  shortId: string
  note: string
  status: string
  /** Сколько раз тикет уходил в «на доработку» — трение видно по числу возвратов, а не по одному. */
  rejections: number
}

// ── столбец графика потока: один день ────────────────────────────────────────────────────────────────────
export type FlowBar = FlowDay // { day, created, verified }

// ── строка разбивки по проектам ──────────────────────────────────────────────────────────────────────────
export type ProjectFlow = {
  projectId: string
  name: string
  /** Заведено за окно FLOW_DAYS. */
  filed: number
  /** Всего тикетов проекта (без архива) — знаменатель, по которому видно вес проекта. */
  total: number
}

// ── перекрёстная адресация: тикет отдан агенту, который эту доску не работает ─────────────────────────────
export type CrossBoard = {
  id: string
  shortId: string
  note: string
  status: string
  assignee: string
  /** Имя проекта (доски) тикета — куда его адресовали. */
  board: string
}

// ── «здоровье системы»: диагностический список ───────────────────────────────────────────────────────────
export type SystemLens = SystemHealth & {
  /** Группы живых сессий с коллизией (одно имя подписывают несколько процессов) — их называем поимённо. */
  collisionGroups: SessionGroup[]
  /** Сессии, писавшие за сутки, но замолчавшие дольше окна живости — возможные забытые форки. */
  recentlySilentSessions: number
  /** Событий в журнале за последние сутки и за неделю — рост, а не только размер. */
  growth24h: number
  growth7d: number
  /** Открытые тикеты, адресованные агенту не с этой доски. */
  crossBoard: CrossBoard[]
}

export type StatsData = {
  agents: AgentRow[]
  dwell: StatusDwell[]
  bounced: Bounced[]
  stuckTaken: number
  stuckReview: number
  orphans: Orphan[]
  flow: FlowBar[]
  projectFlow: ProjectFlow[]
  system: SystemLens
  /** Выборка упёрлась в потолок — значит цифры ЗАНИЖЕНЫ, и говорить их как факт нельзя. */
  truncated: boolean
}

/**
 * Весь журнал, дочитанный до конца. repo.eventsSince режет отдачу на 500 строк за вызов, поэтому читаем
 * страницами до короткой. При размерах доски этого инструмента (сотни событий) это 1–2 запроса на проект —
 * не тот скан на тысячу строк, которого агрегаты ядра избегают, а честное дочитывание ограниченного журнала.
 */
function readAllEvents(): ChangeEvent[] {
  const out: ChangeEvent[] = []
  for (const p of repo.listProjects()) {
    let since = 0
    for (;;) {
      const batch = repo.eventsSince(p.id, since, EVENT_PAGE)
      out.push(...batch)
      const last = batch[batch.length - 1]
      if (batch.length < EVENT_PAGE || !last) break
      since = last.seq // seq строго растёт — цикл конечен
    }
  }
  return out
}

/**
 * Куда привёл переход, по тексту события журнала. Деталь статуса пишется как `${старый} → ${новый}`, а легаси
 * писал `old -> new` или просто новый статус. Совпадение по СУФФИКСУ ловит переход во все три написания и
 * семантически верно: переход классифицируется по тому, КУДА он привёл. Самый длинный подходящий статус —
 * чтобы `review` не перебивал `needs_review`.
 */
function destStatus(detail: string | null): Status | null {
  if (!detail) return null
  const tail = detail.trim().toLowerCase()
  let best: Status | null = null
  for (const s of STATUSES) {
    if (tail.endsWith(s) && (!best || s.length > best.length)) best = s
  }
  return best
}

/** Порядок статусов на графике «время в статусе» — как путь тикета, а не как алфавит. */
const STATUS_RANK = new Map<Status, number>(STATUSES.map((s, i) => [s, i]))

export function collectStats(now: number = Date.now()): StatsData {
  const reports = repo.listReports({ archived: 'all', limit: TICKET_CEILING })
  const truncated = reports.length >= TICKET_CEILING
  const byId = new Map<string, Report>(reports.map((r) => [r.id, r]))
  const events = readAllEvents()

  // ── линза 1: здоровье агентов. Счётчики — из агрегата ядра (всё время: экран про НАКОПЛЕННУЮ работу). ──
  const activity = repo.agentActivity()

  // Время до приёмки, по агенту. Считается от ВЗЯТИЯ работы агентом (takenBy/takenAt на тикете) до момента,
  // когда тикет приняли (событие перехода в verified). Приписывается тому, кто держал работу, — это его цикл
  // «взял → приняли», а не время того, кто нажал «принять».
  const verifiedAt = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== 'status') continue
    if (destStatus(e.detail) !== STATUS_VERIFIED) continue
    const prev = verifiedAt.get(e.reportId)
    if (prev === undefined || e.createdAt > prev) verifiedAt.set(e.reportId, e.createdAt)
  }
  const accept = new Map<string, { sum: number; n: number }>()
  for (const r of reports) {
    if (r.status !== STATUS_VERIFIED || !r.takenBy || r.takenAt == null) continue
    const at = verifiedAt.get(r.id)
    if (at == null || at < r.takenAt) continue // без времени приёмки — не выдумываем длительность
    const h = normalizeIdentity(r.takenBy)
    if (!h) continue
    const acc = accept.get(h) ?? { sum: 0, n: 0 }
    acc.sum += at - r.takenAt
    acc.n += 1
    accept.set(h, acc)
  }

  const profiles = new Map<string, AgentProfile>(repo.listAgents().map((a) => [a.handle, a]))
  const agents: AgentRow[] = activity.map((a): AgentRow => {
    const profile = profiles.get(a.agent) ?? null
    // Живость известного агента — по составу (тот же сигнал, что на рельсе и в /agents); неизвестного actor —
    // по его последнему действию, иначе канал расширения выглядел бы вечно живым.
    const liveBasis = profile ? profile.lastSeen : a.lastEventAt ?? 0
    const acc = accept.get(a.agent)
    return {
      ...a,
      profile,
      liveness: liveness(liveBasis, now),
      avgToAcceptMs: acc ? acc.sum / acc.n : null,
    }
  })
  // Сортировка: сверху — кто несёт больше живой нагрузки (держит открытых тикетов), при равенстве — кто
  // действовал позже. Так экран начинается с тех, на ком сейчас реально висит работа.
  agents.sort((x, y) => y.holding - x.holding || (y.lastEventAt ?? 0) - (x.lastEventAt ?? 0))

  // ── линза 2: заторы и трение. Среднее время в статусе — по завершённым переходам, восстановленным из журнала. ──
  const timelines = new Map<string, { status: Status; at: number }[]>()
  // Затравка «new» — из времени постановки тикета: первый интервал new→(первое событие) иначе потеряется.
  for (const r of reports) timelines.set(r.id, [{ status: STATUS_NEW, at: r.createdAt }])
  for (const e of events) {
    if (e.kind !== 'status') continue
    const line = timelines.get(e.reportId)
    if (!line) continue // событие тикета, которого уже нет в выборке (архивная отсечка/потолок) — пропускаем
    const dest = destStatus(e.detail)
    if (dest) line.push({ status: dest, at: e.createdAt })
  }
  const dwellAcc = new Map<Status, { sum: number; n: number }>()
  for (const line of timelines.values()) {
    for (let i = 0; i < line.length - 1; i++) {
      const cur = line[i]
      const next = line[i + 1]
      if (!cur || !next) continue
      const span = next.at - cur.at
      if (span < 0) continue
      const acc = dwellAcc.get(cur.status) ?? { sum: 0, n: 0 }
      acc.sum += span
      acc.n += 1
      dwellAcc.set(cur.status, acc)
    }
  }
  const dwell: StatusDwell[] = TRANSIENT_STATUSES.map((status) => {
    const acc = dwellAcc.get(status)
    return { status, avgMs: acc ? acc.sum / acc.n : 0, intervals: acc?.n ?? 0 }
  })
    .filter((d) => d.intervals > 0)
    .sort((a, b) => (STATUS_RANK.get(a.status) ?? 0) - (STATUS_RANK.get(b.status) ?? 0))

  // Что возвращают чаще всего: число возвратов на тикет. Один возврат — обычное дело; трение — это тикеты,
  // которые вернули не раз.
  const rejCount = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== 'status') continue
    if (destStatus(e.detail) !== STATUS_REJECTED) continue
    rejCount.set(e.reportId, (rejCount.get(e.reportId) ?? 0) + 1)
  }
  const bounced: Bounced[] = [...rejCount.entries()]
    .map(([id, rejections]): Bounced | null => {
      const r = byId.get(id)
      return r ? { id, shortId: r.shortId, note: r.note, status: r.status, rejections } : null
    })
    .filter((b): b is Bounced => b !== null)
    .sort((a, b) => b.rejections - a.rejections)

  // Застрявшие сейчас: взято дольше срока / ждёт приёмки дольше срока. Считаем по открытым тикетам одним проходом.
  let stuckTaken = 0
  let stuckReview = 0
  for (const r of reports) {
    if (r.archived) continue
    if (r.status === STATUS_TAKEN && now - (r.takenAt ?? r.createdAt) >= STUCK_TAKEN_MS) stuckTaken += 1
    else if (r.status === STATUS_NEEDS_REVIEW && now - r.createdAt >= STUCK_REVIEW_MS) stuckReview += 1
  }

  const orphans = repo.orphans()

  // ── линза 3: поток во времени. Готовый агрегат ядра (UTC-дни) плюс разбивка по проектам за то же окно. ──
  const flow = repo.flowByDay(FLOW_DAYS)
  const windowStart = now - FLOW_DAYS * DAY_MS
  const projects = repo.listProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name] as const))
  const filedInWindow = new Map<string, number>()
  const totalByProject = new Map<string, number>()
  for (const r of reports) {
    if (r.archived) continue
    totalByProject.set(r.projectId, (totalByProject.get(r.projectId) ?? 0) + 1)
    if (r.createdAt >= windowStart) filedInWindow.set(r.projectId, (filedInWindow.get(r.projectId) ?? 0) + 1)
  }
  const projectFlow: ProjectFlow[] = projects
    .map((p): ProjectFlow => ({
      projectId: p.id,
      name: p.name,
      filed: filedInWindow.get(p.id) ?? 0,
      total: totalByProject.get(p.id) ?? 0,
    }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.filed - a.filed || b.total - a.total)

  // ── линза 4: здоровье системы. Агрегат ядра плюс то, что оно не считает: рост журнала, недавно замолчавшие
  // сессии и перекрёстная адресация. ──
  const system = repo.systemHealth()
  const liveGroups = repo.sessionsByAgent() // окно живости SESSION_LIVE_MS
  const collisionGroups = liveGroups.filter((g) => g.count > 1)
  // Сессии, писавшие за сутки, но замолчавшие дольше окна живости: были на связи недавно, сейчас молчат.
  const recentGroups = repo.sessionsByAgent(SILENT_AGENT_MS)
  const liveCutoff = now - SESSION_LIVE_MS
  const recentSessions = recentGroups.flatMap((g) => g.sessions)
  const recentlySilentSessions = recentSessions.filter((s: AgentSession) => s.lastSeen < liveCutoff).length

  let growth24h = 0
  let growth7d = 0
  for (const e of events) {
    if (e.createdAt >= now - DAY_MS) growth24h += 1
    if (e.createdAt >= now - 7 * DAY_MS) growth7d += 1
  }

  // Перекрёстная адресация: открытый тикет отдан агенту, который РАБОТАЕТ другие доски, но не эту. Агента без
  // единой доски не считаем — это «ни разу не работал», другой дефект, и он засыпал бы список ложными строками.
  const openStatuses = new Set<string>([STATUS_NEW, STATUS_TAKEN, STATUS_NEEDS_REVIEW, STATUS_REJECTED])
  const crossBoard: CrossBoard[] = []
  for (const r of reports) {
    if (r.archived || !r.assignee || !openStatuses.has(r.status)) continue
    const a = profiles.get(r.assignee)
    if (!a || a.boards.length === 0 || a.boards.includes(r.projectId)) continue
    crossBoard.push({
      id: r.id,
      shortId: r.shortId,
      note: r.note,
      status: r.status,
      assignee: r.assignee,
      board: projName.get(r.projectId) ?? 'проект',
    })
  }

  const systemLens: SystemLens = {
    ...system,
    collisionGroups,
    recentlySilentSessions,
    growth24h,
    growth7d,
    crossBoard,
  }

  return {
    agents,
    dwell,
    bounced,
    stuckTaken,
    stuckReview,
    orphans,
    flow,
    projectFlow,
    system: systemLens,
    truncated,
  }
}

/** Длительность по-русски, коротко: «меньше минуты», «12 мин», «3 ч», «5 дн». Для средних времён и возрастов. */
export function humanDur(ms: number): string {
  if (ms < 60_000) return 'меньше минуты'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins} мин`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h} ч`
  return `${Math.floor(h / 24)} дн`
}
