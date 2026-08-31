import {
  sameIdentity,
  STATUS_NEW,
  STATUS_TAKEN,
  STATUS_NEEDS_REVIEW,
  STATUS_REJECTED,
  type AgentProfile,
  type SessionGroup,
  type Status,
} from '@th/db'
// Relative, not the '@/' alias the sibling screens use: this module is pure and has a plain-tsx test that runs
// outside Next's path resolver, so it must not depend on an alias only the bundler understands.
import { liveness } from './liveness'

// Менеджер как код: из состояния доски он решает, что должно произойти — и, что не менее важно, чего он делать НЕ
// вправе. Это модуль суждения, а не действия: он предлагает передать тикет или поторопить исполнителя, а всё, что
// требует чужого полномочия или необратимо, отдаёт владельцу. Поверхности (экран и диспетчер) строятся на этом
// контракте; правила здесь читаются одним куском намеренно — «до меры дозволенного» должно быть видно в одном месте.
//
// Почему детерминированное ядро, а LLM — только за швом: понятные случаи (у доски один живой исполнитель — ему и
// передать; тикет висит третий день — поторопить) решаются бесплатно и одинаково при каждом прогоне. Неоднозначное
// ядро НЕ выдумывает: без подключённого LLM-канала оно эскалирует владельцу честно, а не назначает наугад.

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Взято дольше этого — «работа идёт» перестаёт быть разумным допущением. То же число, что на «Моём ходе» и в
 * статистике (STUCK_TAKEN_MS): менеджер обязан звать застрявшим ровно то, что экраны рисуют застрявшим, иначе его
 * суждение разойдётся с тем, что видит владелец. Продублировано, как это уже сделано между mine.ts и stats.ts.
 */
export const STUCK_TAKEN_MS = 3 * DAY_MS
/** Сдано и ждёт приёмки дольше этого — уже долг того, кто принимает, а не очередь (то же число, что на экранах). */
export const STUCK_REVIEW_MS = 2 * DAY_MS
/**
 * Сколько только что поставленный тикет остаётся без вмешательства менеджера. Свежий тикет доска нередко разбирает
 * сама — агент видит инбокс и берёт работу; назначать через секунду после постановки значит отнимать это у доски и
 * плодить ложные передачи. За этим порогом «никто не взял» перестаёт быть «ещё не успели».
 */
export const ROUTE_AFTER_MS = 60 * 60 * 1000

/** Короче этого слово не несёт домена — «и», «на», «bug» отсекаются как шум при сверке темы тикета и роли агента. */
const MIN_TOKEN_LEN = 4

// ── что предлагает менеджер ──────────────────────────────────────────────────────────────────────────────────

/**
 * Виды предложений — и ровно они. Здесь НЕТ ни «принять», ни «вернуть», ни чего-либо необратимого: это и есть
 * граница дозволенного, выраженная типом. Менеджер может передать работу (assign), поторопить (nudge), отдать
 * решение владельцу (escalate) или осознанно ничего не делать (leave). Всё остальное — не его ход.
 */
export type RoutingKind = 'assign' | 'nudge' | 'escalate' | 'leave'
export type Confidence = 'high' | 'low'
/** Откуда взялось предложение: детерминированное правило или LLM-подсказка за швом. */
export type ProposalSource = 'rule' | 'llm'

export type RoutingProposal = {
  kind: RoutingKind
  ticketId: string
  shortId: string
  /** Одно предложение по-русски — та строка, которую владелец читает и по которой понимает, что и почему. */
  reason: string
  /** Кому передать (assign) или кого поторопить (nudge). У escalate/leave обычно пусто. */
  suggestedAgent?: string
  confidence: Confidence
  source: ProposalSource
}

export type RoutingPlan = {
  proposals: RoutingProposal[]
  /**
   * Был ли неоднозначный тикет отдан LLM хоть раз. false при выключенном канале означает: всё неоднозначное ушло
   * владельцу, менеджер ничего не выдумывал — это честный дефолт сегодняшней ночи, а не тихая догадка.
   */
  usedLlm: boolean
}

// ── граница дозволенного: «до меры дозволенного» как код, а не как комментарий ────────────────────────────────

/**
 * Единственные действия, которые менеджер вправе ПРИМЕНИТЬ сам. Список-allowlist намеренно: что в него не внесено —
 * запрещено по умолчанию, и добавить новое опасное действие можно только правкой этой строки, на глазах у ревью.
 */
export const MANAGER_APPLICABLE: readonly RoutingKind[] = [ 'assign', 'nudge' ]

/**
 * Действия, которые менеджер не совершает НИКОГДА, — зафиксированы явно, чтобы тест мог их перечислить и доказать
 * запрет. Приёмка и возврат — по правилу доски слово только филера или владельца; деньги, прод и внешние публикации —
 * необратимое, всегда escalate-only. Менеджер — не филер и не владелец.
 */
export const MANAGER_FORBIDDEN: readonly string[] = [
  'verify', 'verified', 'reject', 'rejected', 'wontfix', 'money', 'prod', 'publish',
]

/**
 * Вправе ли менеджер ПРИМЕНИТЬ действие этого вида. Проверяют и менеджер (при сборке плана), и диспетчер (перед
 * применением) — один источник правды. Всё, чего нет в MANAGER_APPLICABLE, получает false, включая любой запрещённый
 * глагол: сделать предложение запрещённого вида применимым невозможно.
 */
export function managerMayAct(kind: string): boolean {
  return (MANAGER_APPLICABLE as readonly string[]).includes(kind)
}

/** Применимо ли предложение — единственный путь к «да» лежит через managerMayAct(kind). */
export function isApplicable(p: Pick<RoutingProposal, 'kind'>): boolean {
  return managerMayAct(p.kind)
}

// ── состояние доски, из которого менеджер судит ──────────────────────────────────────────────────────────────

/**
 * Проекция открытого тикета — ровно то, что нужно для решения. Поверхность собирает её из repo (открытые reports),
 * а не менеджер: так модуль остаётся чистым и не зависит от базы, комментариев и времени.
 */
export type ManagerTicket = {
  id: string
  shortId: string
  /** Ключ доски (reports.projectId) — по нему сверяются boards агента. */
  projectId: string
  /** Человекочитаемое имя доски для строки-причины; поверхность подставляет имя проекта. */
  board: string
  note: string
  status: Status
  assignee: string | null
  takenBy: string | null
  /**
   * С какого момента тикет в своём текущем состоянии: взятие (takenAt) для taken/rejected, время сдачи на приёмку
   * для needs_review, постановка (createdAt) для new. Считает поверхность — у неё уже есть эта логика (mine.ts).
   */
  since: number
}

export type ManagerState = {
  /** Только открытые тикеты — принятое и «не делаем» ничьего хода не ждут. */
  tickets: ManagerTicket[]
  /**
   * Состав, из которого выбирается исполнитель. Владельца и расширение поверхность сюда НЕ кладёт: первый — тот, кому
   * менеджер докладывает, второй — канал, а не исполнитель.
   */
  roster: AgentProfile[]
  /** Живые сессии с коллизией (одно имя подписывают несколько процессов) — repo.sessionsByAgent, count > 1. */
  collisions: SessionGroup[]
  now: number
}

// ── LLM-хук: шов, за которым завтра включат бесплатный канал (Gemini / подписка Codex) ────────────────────────

/**
 * Единственная точка, где менеджер может спросить «кому это?» у модели. Возвращает handle исполнителя или строку
 * "escalate". Канал меняется в одну строку — подключается транспорт (запрос к Gemini/Codex), а тип не двигается.
 * Сегодня хук не передаётся: неоднозначное эскалируется, а не угадывается. Внешних вызовов на этом этапе нет.
 */
export type ManagerLLM = (prompt: string) => Promise<string>

/** Что LLM возвращает, когда решает не выбирать, — тогда тикет уходит владельцу. */
export const LLM_ESCALATE = 'escalate'

/**
 * Промпт для LLM-хука: тикет и список допустимых исполнителей с их ролями. Вынесен и экспортирован, чтобы канал
 * лишь доставлял его, а тест мог проверить, что кандидаты и правило ответа в нём есть.
 */
export function buildRoutingPrompt(ticket: ManagerTicket, candidates: AgentProfile[]): string {
  const roster = candidates.map((a) => `- ${a.handle}: ${a.role || a.title || 'роль не указана'}`).join('\n')
  return (
    `Тикет на доске «${ticket.board}»: ${ticket.note}\n\n` +
    `Кому из этих исполнителей его передать? Ответь ОДНИМ handle из списка или словом "${LLM_ESCALATE}", ` +
    `если ни один не подходит явно.\n${roster}`
  )
}

// ── детерминированное ядро ────────────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set<string>([
  // Русские служебные и слишком общие для домена
  'это', 'что', 'как', 'при', 'для', 'или', 'если', 'после', 'перед', 'через', 'тикет', 'баг', 'ошибка', 'нужно',
  'есть', 'быть', 'страница', 'кнопка', 'экран',
  // Английские
  'this', 'that', 'with', 'from', 'when', 'page', 'button', 'error', 'issue', 'bug', 'fix', 'need', 'should',
])

/** Доменные токены строки: буквы/цифры, в нижнем регистре, длиннее порога, без стоп-слов. */
function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    if (w.length >= MIN_TOKEN_LEN && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Пересекаются ли темы тикета и роли агента хоть одним доменным токеном. */
function domainOverlap(ticket: ManagerTicket, agent: AgentProfile): boolean {
  const role = tokens(`${agent.role} ${agent.title}`)
  if (role.size === 0) return false
  for (const w of tokens(ticket.note)) if (role.has(w)) return true
  return false
}

const proposal = (
  kind: RoutingKind,
  t: ManagerTicket,
  reason: string,
  extra: { suggestedAgent?: string; confidence: Confidence; source: ProposalSource },
): RoutingProposal => ({
  kind,
  ticketId: t.id,
  shortId: t.shortId,
  reason,
  suggestedAgent: extra.suggestedAgent,
  confidence: extra.confidence,
  source: extra.source,
})

/** Порядок вывода: сначала то, что требует внимания владельца, затем торопёж, назначения и осознанное бездействие. */
const KIND_RANK: Record<RoutingKind, number> = { escalate: 0, nudge: 1, assign: 2, leave: 3 }

/**
 * Кому можно передать работу СЕЙЧАС: в составе, активен, на связи (сутки без тишины) и не в коллизии. Молчащему
 * назначать нельзя — по правилу доски (LIVENESS_HINT) считать, что у него идёт работа, уже нельзя; коллизия значит,
 * что имя подписывают несколько процессов, и подкладывать им ещё один тикет — верный двойной прогон.
 */
function eligibleAgents(state: ManagerState, colliding: Set<string>): AgentProfile[] {
  return state.roster.filter(
    (a) => a.active && liveness(a.lastSeen, state.now) === 'live' && !colliding.has(a.handle),
  )
}

/** Разбор одного неразобранного (new/rejected без держателя) тикета: назначить, спросить LLM или эскалировать. */
async function routeUnclaimed(
  t: ManagerTicket,
  state: ManagerState,
  colliding: Set<string>,
  llm: ManagerLLM | undefined,
): Promise<{ proposal: RoutingProposal; usedLlm: boolean }> {
  const boardBound = state.roster.filter((a) => a.boards.includes(t.projectId))
  const eligible = eligibleAgents(state, colliding).filter((a) => a.boards.includes(t.projectId))

  // Ни один активный исполнитель не закреплён за доской — некому поручить, это решение владельца (доступ/состав).
  if (boardBound.filter((a) => a.active).length === 0) {
    return {
      proposal: proposal('escalate', t, `«${t.shortId}»: за доской «${t.board}» не закреплён ни один активный исполнитель — некому поручить, нужно ваше решение.`, {
        confidence: 'low',
        source: 'rule',
      }),
      usedLlm: false,
    }
  }

  // Закреплённые есть, но никого нельзя взять сейчас (молчат или в коллизии) — тоже к владельцу, честно назвав причину.
  if (eligible.length === 0) {
    const only = boardBound.find((a) => a.active)
    const why = only && colliding.has(only.handle) ? 'сейчас в коллизии' : 'больше суток молчит'
    return {
      proposal: proposal('escalate', t, `«${t.shortId}»: единственный подходящий по доске «${t.board}» исполнитель ${only?.handle ?? ''} ${why} — не на кого положиться.`, {
        confidence: 'low',
        source: 'rule',
      }),
      usedLlm: false,
    }
  }

  // Ровно один живой исполнитель доски — доска и есть маршрут, передаём уверенно.
  if (eligible.length === 1) {
    const a = eligible[0]!
    const themed = domainOverlap(t, a)
    return {
      proposal: proposal('assign', t, themed
        ? `«${t.shortId}»: ${a.handle} закреплён за доской «${t.board}» и профильно подходит по теме — передаю ему.`
        : `«${t.shortId}»: ${a.handle} — единственный на связи исполнитель доски «${t.board}»; передаю ему.`, {
        suggestedAgent: a.handle,
        confidence: 'high',
        source: 'rule',
      }),
      usedLlm: false,
    }
  }

  // Несколько живых кандидатов доски. Тема-разводящий: ровно один совпал по домену — берём его уверенно.
  const themed = eligible.filter((a) => domainOverlap(t, a))
  if (themed.length === 1) {
    const a = themed[0]!
    return {
      proposal: proposal('assign', t, `«${t.shortId}»: из исполнителей доски «${t.board}» по теме однозначно подходит ${a.handle} — передаю ему.`, {
        suggestedAgent: a.handle,
        confidence: 'high',
        source: 'rule',
      }),
      usedLlm: false,
    }
  }

  // По-настоящему неоднозначно: несколько равных кандидатов. Спросить LLM, если канал включён, иначе — к владельцу.
  if (llm) {
    const answer = (await llm(buildRoutingPrompt(t, eligible))).trim()
    const picked = eligible.find((a) => sameIdentity(a.handle, answer.toLowerCase()))
    if (picked) {
      return {
        proposal: proposal('assign', t, `«${t.shortId}»: несколько исполнителей доски «${t.board}» подходят, помощник выбрал ${picked.handle} — проверьте.`, {
          suggestedAgent: picked.handle,
          confidence: 'low',
          source: 'llm',
        }),
        usedLlm: true,
      }
    }
    // LLM вернул "escalate" или неизвестный handle — не выдумываем, отдаём владельцу; источник honest.
    const source: ProposalSource = answer.toLowerCase() === LLM_ESCALATE ? 'llm' : 'rule'
    return {
      proposal: proposal('escalate', t, `«${t.shortId}»: по доске «${t.board}» подходят несколько исполнителей, автоматически выбрать не удалось — выберите вручную.`, {
        confidence: 'low',
        source,
      }),
      usedLlm: true,
    }
  }

  return {
    proposal: proposal('escalate', t, `«${t.shortId}»: по доске «${t.board}» подходят несколько исполнителей одинаково — выберите, кому передать.`, {
      confidence: 'low',
      source: 'rule',
    }),
    usedLlm: false,
  }
}

/**
 * Главный вход: из состояния доски — план предложений. Асинхронный, потому что за швом может стоять LLM; без него
 * (дефолт сегодня) awaits нет и план собирается детерминированно.
 *
 * @param llm необязательный канал к модели для неоднозначных тикетов; отсутствует — неоднозначное эскалируется.
 */
export async function computeRoutingPlan(state: ManagerState, llm?: ManagerLLM): Promise<RoutingPlan> {
  const colliding = new Set<string>(state.collisions.filter((g) => g.count > 1).map((g) => g.agent))
  const proposals: RoutingProposal[] = []
  let usedLlm = false

  for (const t of state.tickets) {
    const age = state.now - t.since

    if (t.status === STATUS_TAKEN) {
      const holder = t.takenBy
      // Коллизия важнее простоя: тикет держит имя, которое подписывают несколько процессов — это риск двойной работы,
      // и это решение владельца, а не «поторопить».
      if (holder && colliding.has(holder)) {
        proposals.push(proposal('escalate', t, `«${t.shortId}» держит ${holder}, но под этим именем сейчас работают несколько процессов — возможен двойной прогон, нужно ваше решение.`, {
          confidence: 'low',
          source: 'rule',
        }))
      } else if (age >= STUCK_TAKEN_MS) {
        proposals.push(proposal('nudge', t, `«${t.shortId}» взят ${holder ?? 'исполнителем'} более трёх дней назад и не вернулся — стоит поторопить.`, {
          suggestedAgent: holder ?? undefined,
          confidence: 'high',
          source: 'rule',
        }))
      }
      // Здоровое «в работе» менеджер не трогает — микроменеджмент идущей работы был бы шумом.
      continue
    }

    if (t.status === STATUS_NEEDS_REVIEW) {
      if (age >= STUCK_REVIEW_MS) {
        // Приёмку менеджер сделать НЕ вправе (граница) — он лишь торопит того, за кем слово: филера.
        proposals.push(proposal('nudge', t, `«${t.shortId}» ждёт приёмки филера более двух дней — стоит напомнить принять или вернуть.`, {
          suggestedAgent: t.assignee ?? undefined,
          confidence: 'high',
          source: 'rule',
        }))
      }
      continue
    }

    // new / rejected: адресован ли уже кому-то?
    const addressed = t.status === STATUS_NEW && t.assignee
    if (addressed) {
      const a = state.roster.find((x) => sameIdentity(x.handle, t.assignee))
      // Назначен и жив — уже маршрутизирован, менеджер осознанно не вмешивается.
      if (a && a.active && liveness(a.lastSeen, state.now) === 'live') {
        proposals.push(proposal('leave', t, `«${t.shortId}» уже назначен ${t.assignee} и ждёт взятия — вмешательство не требуется.`, {
          confidence: 'high',
          source: 'rule',
        }))
      } else {
        // Назначен, но молчит/выведен из состава — работа стоит на мёртвом адресе, это к владельцу.
        proposals.push(proposal('escalate', t, `«${t.shortId}» назначен ${t.assignee}, но тот молчит и не берёт работу — вмешайтесь.`, {
          confidence: 'low',
          source: 'rule',
        }))
      }
      continue
    }

    // Свежий и неразобранный — даём доске шанс взять самой, прежде чем назначать.
    if (age < ROUTE_AFTER_MS) {
      proposals.push(proposal('leave', t, `«${t.shortId}» поставлен недавно — даю доске самой разобрать, прежде чем назначать.`, {
        confidence: 'high',
        source: 'rule',
      }))
      continue
    }

    const routed = await routeUnclaimed(t, state, colliding, llm)
    proposals.push(routed.proposal)
    usedLlm = usedLlm || routed.usedLlm
  }

  proposals.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.shortId.localeCompare(b.shortId))
  return { proposals, usedLlm }
}
