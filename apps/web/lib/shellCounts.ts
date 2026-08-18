import { repo, STATUS_NEEDS_REVIEW } from '@th/db'
import { liveness } from '@/lib/liveness'

// Цифры на рельсе. Считаются на сервере при каждом заходе (все страницы панели — force-dynamic), поэтому
// «ждут вас: 3» не может быть кэшем вчерашнего дня.

// repo.listReports отдаёт не больше тысячи строк. Спросив ровно потолок и получив ровно потолок, отличить
// «столько и есть» от «здесь запрос кончился» невозможно, поэтому потолок назван и проверяется явно.
const TICKET_CEILING = 1000

export type ShellCounts = {
  /** needs_review — тикеты, которые может закрыть только он. */
  mine: number
  /** Активные тикеты (без архива). */
  tickets: number
  agentsLive: number
  agentsTotal: number
  /** Хотя бы один из счётчиков упёрся в потолок выборки — цифра занижена, и это надо сказать вслух. */
  truncated: boolean
}

export function shellCounts(now: number = Date.now()): ShellCounts {
  const review = repo.listReports({ status: STATUS_NEEDS_REVIEW, archived: false, limit: TICKET_CEILING })
  const active = repo.listReports({ archived: false, limit: TICKET_CEILING })
  const agents = repo.listAgents()
  return {
    mine: review.length,
    tickets: active.length,
    agentsLive: agents.filter((a) => a.active && liveness(a.lastSeen, now) === 'live').length,
    agentsTotal: agents.length,
    truncated: active.length >= TICKET_CEILING || review.length >= TICKET_CEILING,
  }
}
