import type { ReactNode } from 'react'
import type { EventKind, Status } from '@th/db'
import type { TimelineEntry } from '@/app/r/[id]/timeline'
import { statusLabel } from '@/components/status'
import type { RosterMap } from '@/components/agents'
import { agentName } from '@/components/agents'
import { agoLong, exact } from '@/lib/time'
import { cx } from '@/lib/cx'
import s from './TicketHistory.module.css'

// Лента истории тикета — прямой ответ на «какой из форков закрыл тикет». У каждого события стоит, кто его
// сделал, и — где известно — из какой СЕССИИ: одно имя `erental` подписывают десятки процессов, и раньше
// они были неразличимы. Событие с HTTP-пути (панель владельца, расширение) сессии не несёт, и строка честно
// показывает только автора, не выдумывая происхождение.

// Сколько символов id сессии показать, когда её строку происхождения найти не удалось: id всё равно различает
// форки, просто без человеческой подписи. Полный id (uuid) в строку не влезает и читается как шум.
const SHORT_SESSION_LEN = 8

/** Глагол вместо «старый → новый»: в истории читается «принял», а не «needs_review → verified». */
const MOVE_VERB: Record<Status, string> = {
  new: 'вернул в новые',
  taken: 'взял в работу',
  needs_review: 'сдал на проверку',
  verified: 'принял',
  rejected: 'вернул на доработку',
  wontfix: 'отклонил',
}

// Пункт назначения статусного перехода из detail вида «old → new». Стрелку пишет маршрут PATCH; допускаем и
// голый статус в легаси-строках. Незнакомый статус показываем как есть — незнакомое обязано выглядеть незнакомо.
function destStatus(detail: string | null): string | null {
  if (!detail) return null
  const parts = detail.split(/→|->/)
  return parts[parts.length - 1]?.trim() || null
}

// Хвост после стрелки для «передал → кому» и «перенёс → куда». Тот же разбор, что и у статуса.
function tail(detail: string | null): string | null {
  if (!detail) return null
  const parts = detail.split(/→|->/)
  return parts.length > 1 ? parts[parts.length - 1]?.trim() || null : null
}

/** Что произошло, словами владельца. Возвращает готовый узел, потому что статус несёт свой цвет. */
function describe(kind: EventKind, detail: string | null): ReactNode {
  switch (kind) {
    case 'created':
      return 'завёл тикет'
    case 'status': {
      const dest = destStatus(detail)
      const verb = dest ? (MOVE_VERB as Record<string, string | undefined>)[dest] : undefined
      return verb ?? (dest ? `перевёл в «${statusLabel(dest)}»` : 'сменил статус')
    }
    case 'assigned': {
      const who = tail(detail)
      return who && who !== '—' ? `передал → ${who}` : 'снял адресата'
    }
    case 'moved':
      return tail(detail) ? `перенёс на доску ${tail(detail)}` : 'перенёс на другую доску'
    case 'archived':
      return 'изменил архивность'
    default:
      return kind
  }
}

// Как показать сессию: развёрнутое происхождение, если нашли; иначе короткий id как различитель форков.
function sessionLabel(entry: TimelineEntry): string | null {
  if (!entry.sessionId) return null
  return entry.origin ?? `${entry.sessionId.slice(0, SHORT_SESSION_LEN)}…`
}

export default function TicketHistory({
  entries,
  roster,
}: {
  entries: readonly TimelineEntry[]
  roster: RosterMap
}) {
  if (entries.length === 0) {
    return <p className={s.empty}>Журнал по этому тикету пуст — он старше журнала действий.</p>
  }
  return (
    <ol className={s.list}>
      {entries.map((e) => {
        const session = sessionLabel(e)
        return (
          <li className={s.row} key={e.seq}>
            <span className={s.who} title={roster[e.actor]?.role ?? undefined}>
              {agentName(e.actor, roster)}
            </span>
            <span className={s.what}>{describe(e.kind, e.detail)}</span>
            {session ? (
              // Ответ на «какой форк это сделал». origin — то, что агент назвал при старте; без него короткий id.
              <span
                className={cx(s.session, !e.origin && s.session_raw)}
                title={
                  e.origin
                    ? `Сессия ${e.sessionId} · происхождение: ${e.origin}`
                    : `Сессия ${e.sessionId} — происхождение не найдено в записи`
                }
              >
                сессия {session}
              </span>
            ) : null}
            <time className={s.when} title={exact(e.at)}>
              {agoLong(e.at)}
            </time>
          </li>
        )
      })}
    </ol>
  )
}
