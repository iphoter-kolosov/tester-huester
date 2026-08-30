import { repo, type ChangeEvent, type EventKind } from '@th/db'

// История одного тикета: кто его двигал и — там, где это известно — ИЗ КАКОЙ СЕССИИ. Это прямой ответ на
// вопрос владельца «какой из форков закрыл тикет»: одно имя `erental` подписывают десятки процессов, и до
// сессий отличить их было нельзя. Событие несёт session_id того процесса, который его записал; здесь мы
// разворачиваем этот id в понятную строку происхождения (worktree/pid/host), которую агент назвал при старте.

// У доски нет чтения журнала по одному тикету — есть только «всё в проекте после seq». Значит историю тикета
// приходится собирать, проходя журнал проекта постранично и отбирая свои строки. Обрывать проход на первой
// странице — тихая потеря поздних событий (ровно тот тип поломки, который здесь и выправляется), поэтому идём
// до конца: страница короче потолка = журнал кончился.
const JOURNAL_PAGE = 500

// Сессии, из которых писались события, давно завершились, но их строки в agent_sessions не удаляются никогда.
// Живое окно (минуты) их бы спрятало, а нам нужно происхождение для СТАРЫХ строк истории — поэтому спрашиваем
// «любая сессия, что есть в записи», а не «сессия, что отвечала только что».
const ANY_SESSION_ON_RECORD = Number.MAX_SAFE_INTEGER

// Что показываем в истории: только то, что двигает тикет. Реплики уже стоят в обсуждении отдельной лентой, а
// правки заметки — шум для этой ленты; дублировать их здесь значит утопить статусные переходы, ради которых
// история и открывается.
const SHOWN_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['created', 'status', 'assigned', 'moved', 'archived'])

/** Одна строка истории: событие плюс развёрнутое происхождение сессии (null — писала не сессия, а HTTP-путь). */
export type TimelineEntry = {
  seq: number
  kind: EventKind
  actor: string
  detail: string | null
  at: number
  /** id сессии, записавшей событие; null для событий с HTTP-пути (панель, расширение) — там сессии нет. */
  sessionId: string | null
  /** Строка происхождения этой сессии (worktree/pid/host), если её удалось найти в записи; иначе null. */
  origin: string | null
}

/** Все события проекта, страница за страницей, до конца журнала. Отбор по тикету — уже на нашей стороне. */
function eventsForReport(projectId: string, reportId: string): ChangeEvent[] {
  const mine: ChangeEvent[] = []
  let since = 0
  for (;;) {
    const page = repo.eventsSince(projectId, since, JOURNAL_PAGE)
    for (const e of page) if (e.reportId === reportId) mine.push(e)
    const last = page[page.length - 1]
    if (!last || page.length < JOURNAL_PAGE) break
    since = last.seq
  }
  return mine
}

/**
 * История тикета в порядке чтения (новое сверху), с развёрнутой сессией у каждого события, которое её несёт.
 *
 * Происхождение сессии не хранится в событии — событие несёт лишь id. Разворачиваем его через сессии тех
 * агентов, что в этой истории писали: по одному запросу на имя, а имён на тикете единицы. Не нашли строку
 * сессии — origin остаётся null, и страница честно покажет короткий id вместо выдуманного пути.
 */
export function reportTimeline(projectId: string, reportId: string): TimelineEntry[] {
  const events = eventsForReport(projectId, reportId).filter((e) => SHOWN_KINDS.has(e.kind))

  // id сессии → строка происхождения. Собираем только по актёрам, которые в ЭТОЙ истории писали из сессии:
  // у владельца и расширения сессий нет, спрашивать их бессмысленно.
  const originBySession = new Map<string, string>()
  const actorsWithSession = new Set(events.filter((e) => e.session).map((e) => e.actor))
  for (const actor of actorsWithSession) {
    for (const s of repo.liveSessions(actor, ANY_SESSION_ON_RECORD)) {
      if (s.origin) originBySession.set(s.sessionId, s.origin)
    }
  }

  return events
    .map((e) => ({
      seq: e.seq,
      kind: e.kind,
      actor: e.actor,
      detail: e.detail,
      at: e.createdAt,
      sessionId: e.session,
      origin: e.session ? (originBySession.get(e.session) ?? null) : null,
    }))
    .sort((a, b) => b.seq - a.seq)
}
