import {
  repo,
  sameIdentity,
  IDENTITY_EXTENSION,
  IDENTITY_OWNER,
  STATUS_NEEDS_REVIEW,
  type AgentProfile,
  type Report,
  type Status,
} from '@th/db'
import { isOpen } from './mine'
import {
  computeRoutingPlan,
  isApplicable,
  type ManagerState,
  type ManagerTicket,
  type RoutingProposal,
} from './manager'
import type { AutonomyMode } from '@th/db'
import type { DigestInput, DigestSection } from './digest'

// Сборка состояния доски для менеджера и раскладка его плана по разделам экрана.
//
// Модуль manager.ts намеренно чист и без базы — вопрос «кому что» он решает по ПРОЕКЦИИ доски. Здесь и
// живёт эта проекция: открытые тикеты, состав без владельца и расширения, коллизии сессий. Всё, что экран
// потом рисует построчно (снимок тикета, имя и живость предложенного исполнителя), собирается тем же
// проходом, чтобы страница только показывала, а не считала.

/**
 * Потолок выборки repo.listReports. Спросив ровно потолок и получив ровно потолок, «столько и есть» от
 * «здесь запрос кончился» не отличить — поэтому он назван и проверяется явно (см. `truncated`). То же число,
 * что на «Моём ходе» и в статистике.
 */
export const TICKET_CEILING = 1000

/**
 * Кого менеджер вправе рассматривать как исполнителя. `owner` — тот, кому менеджер докладывает; `extension` —
 * канал, которым тикеты СНИМАЮТ, а не выполняют. Ни один не адресат, и оба убираются здесь, на поверхности,
 * ровно как это делает mine.ts перед своим списком «кому отдать».
 */
const isAssignableAgent = (a: AgentProfile): boolean =>
  !sameIdentity(a.handle, IDENTITY_OWNER) && !sameIdentity(a.handle, IDENTITY_EXTENSION)

/**
 * С какого момента тикет в своём текущем состоянии — та же логика, что на «Моём ходе»: сдано на приёмку —
 * с момента сдачи (по последнему отчёту), иначе — с взятия, а не бралось — с постановки. Считать это обязана
 * поверхность: у неё есть доступ к базе, которого нет у чистого manager.ts.
 */
function ticketSince(report: Report): number {
  if (report.status === STATUS_NEEDS_REVIEW) {
    const check = repo.latestVerification(report.id)
    return check?.createdAt ?? report.createdAt
  }
  return report.takenAt ?? report.createdAt
}

/** Одно предложение вместе с тем, что нужно показать рядом: сам тикет и профиль предложенного исполнителя. */
export type ManagerRow = {
  proposal: RoutingProposal
  /** Тикет предложения. null — тикет исчез между сборкой плана и отрисовкой; строка всё равно видна, иначе экран молча врёт. */
  report: Report | null
  /** Кого предлагают (assign/nudge). null — предложение без адресата или адресат уже не в составе. */
  suggested: AgentProfile | null
}

export type ManagerView = {
  /**
   * Обращались ли к LLM хоть раз. false (дефолт сегодня, канал выключен) означает: всё неоднозначное ушло в
   * «тебе решать», менеджер ничего не выдумывал.
   */
  usedLlm: boolean
  /** «Предлагаю раздать» — назначения. */
  assigns: ManagerRow[]
  /** «Застряло, подтолкнуть» — торопёж держателя или филера. */
  nudges: ManagerRow[]
  /** «Тебе решать» — эскалации: неоднозначная маршрутизация, коллизии, всё, что менеджер решать не вправе. */
  escalations: ManagerRow[]
  /** assign + высокая уверенность — то, что уходит одной кнопкой «раздать всё уверенное». */
  confident: ManagerRow[]
  /** Осознанно оставлено доске (kind='leave'): построчно не показываем, но считаем — чтобы не прятать. */
  leaveCount: number
  /** Выборка упёрлась в потолок — план построен по ЧАСТИ доски, и это надо сказать вслух. */
  truncated: boolean
}

export async function collectManager(now: number = Date.now()): Promise<ManagerView> {
  const active = repo.listReports({ archived: false, limit: TICKET_CEILING })
  const open = active.filter(isOpen)
  const reportById = new Map(open.map((r) => [r.id, r] as const))

  const projName = new Map(repo.listProjects().map((p) => [p.id, p.name] as const))
  const roster = repo.listAgents().filter(isAssignableAgent)
  const agentByHandle = new Map(roster.map((a) => [a.handle, a] as const))

  const tickets: ManagerTicket[] = open.map((r) => ({
    id: r.id,
    shortId: r.shortId,
    projectId: r.projectId,
    board: projName.get(r.projectId) ?? 'проект',
    note: r.note,
    // Открытый тикет всегда несёт статус жизненного цикла (OPEN_STATUSES — значения Status), поэтому приведение
    // безопасно: строковый статус легаси-строкой сюда не доходит — isOpen его не пропустит.
    status: r.status as Status,
    assignee: r.assignee,
    takenBy: r.takenBy,
    since: ticketSince(r),
  }))

  const state: ManagerState = {
    tickets,
    roster,
    // Модуль сам отфильтрует count>1 — передаём группы как есть, ровно как обещает контракт.
    collisions: repo.sessionsByAgent(),
    now,
  }

  const plan = await computeRoutingPlan(state)

  const row = (p: RoutingProposal): ManagerRow => ({
    proposal: p,
    report: reportById.get(p.ticketId) ?? null,
    suggested: p.suggestedAgent ? agentByHandle.get(p.suggestedAgent) ?? null : null,
  })

  const rows = plan.proposals.map(row)
  const assigns = rows.filter((r) => r.proposal.kind === 'assign')
  const nudges = rows.filter((r) => r.proposal.kind === 'nudge')
  const escalations = rows.filter((r) => r.proposal.kind === 'escalate')
  // isApplicable — та самая проверка границы, которую диспетчер обязан свериться ПЕРЕД применением: в пакет
  // «раздать всё уверенное» попадает только применимое (assign) и только уверенное.
  const confident = assigns.filter((r) => r.proposal.confidence === 'high' && isApplicable(r.proposal))
  const leaveCount = rows.filter((r) => r.proposal.kind === 'leave').length

  return {
    usedLlm: plan.usedLlm,
    assigns,
    nudges,
    escalations,
    confident,
    leaveCount,
    truncated: active.length >= TICKET_CEILING,
  }
}

/**
 * Project a ManagerView into the plain DigestInput the composer takes. Kept here (DB-coupled side) rather than in
 * digest.ts so the composer stays pure and testable: the digest module never imports repo. A row whose ticket
 * vanished between plan and render carries no report; it is dropped from the digest — the manager screen shows the
 * gap live, but a digest is a snapshot and listing a ghost line would only confuse.
 */
export function toDigestInput(view: ManagerView, autonomy: AutonomyMode, now: number = Date.now()): DigestInput {
  const projName = new Map(repo.listProjects().map((p) => [p.id, p.name] as const))
  const section = (row: ManagerRow): DigestSection | null =>
    row.report
      ? {
          shortId: row.report.shortId,
          board: projName.get(row.report.projectId) ?? 'проект',
          note: row.report.note,
          reason: row.proposal.reason,
          suggested: row.proposal.suggestedAgent,
        }
      : null
  const rows = (list: ManagerRow[]): DigestSection[] => list.map(section).filter((x): x is DigestSection => x !== null)
  return {
    now,
    autonomy,
    usedLlm: view.usedLlm,
    assigns: rows(view.assigns),
    nudges: rows(view.nudges),
    escalations: rows(view.escalations),
    leaveCount: view.leaveCount,
    truncated: view.truncated,
  }
}
