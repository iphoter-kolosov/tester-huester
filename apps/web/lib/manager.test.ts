// The manager's judgment against a hand-built board. Pure — no database: computeRoutingPlan takes a projected
// ManagerState, so every fixture below is a plain literal and every expectation is hand-reasoned from it.
//
// Run: npx tsx apps/web/lib/manager.test.ts
import assert from 'node:assert/strict'
import {
  computeRoutingPlan,
  managerMayAct,
  isApplicable,
  buildRoutingPrompt,
  MANAGER_FORBIDDEN,
  ROUTE_AFTER_MS,
  STUCK_TAKEN_MS,
  STUCK_REVIEW_MS,
  type ManagerState,
  type ManagerTicket,
  type ManagerLLM,
  type RoutingProposal,
  type RoutingKind,
} from './manager.ts'
import { STATUS_NEW, STATUS_TAKEN, STATUS_NEEDS_REVIEW, type AgentProfile, type SessionGroup } from '@th/db'

let passed = 0
function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++
    void name
  })
}

const NOW = 1_000 * DAY() // an arbitrary fixed "now" far from epoch so ages are unambiguous
function DAY(): number {
  return 24 * 60 * 60 * 1000
}
const ago = (ms: number): number => NOW - ms

// ── roster ────────────────────────────────────────────────────────────────────────────────────────────────────
// Two boards: "shop" and "infra". live/quiet is set via lastSeen relative to NOW (>24h => quiet, not routable).
const agent = (o: Partial<AgentProfile> & Pick<AgentProfile, 'handle'>): AgentProfile => ({
  handle: o.handle,
  title: o.title ?? o.handle,
  role: o.role ?? '',
  boards: o.boards ?? [],
  firstSeen: o.firstSeen ?? ago(30 * DAY()),
  lastSeen: o.lastSeen ?? ago(60 * 1000), // live by default (a minute ago)
  active: o.active ?? true,
})

const roster: AgentProfile[] = [
  agent({ handle: 'shopkeeper', role: 'Витрина магазина: каталог, корзина, цены и скидки.', boards: ['shop'] }),
  agent({ handle: 'ops', role: 'Инфраструктура: боксы, docker, база и туннели.', boards: ['infra'] }),
  // Two live agents both bound to "design" with no distinguishing domain word — the ambiguous case.
  agent({ handle: 'design-a', role: 'Дизайн интерфейса доски.', boards: ['design'] }),
  agent({ handle: 'design-b', role: 'Дизайн интерфейса доски.', boards: ['design'] }),
  // Bound to "shop" but silent — proves a stale-only board escalates instead of routing to a ghost.
  agent({ handle: 'sleeper', role: 'Витрина, но давно молчит.', boards: ['stale'], lastSeen: ago(9 * DAY()) }),
]

const ticket = (o: Partial<ManagerTicket> & Pick<ManagerTicket, 'id' | 'projectId' | 'status'>): ManagerTicket => ({
  id: o.id,
  shortId: o.shortId ?? o.id,
  projectId: o.projectId,
  board: o.board ?? o.projectId,
  note: o.note ?? '',
  status: o.status,
  assignee: o.assignee ?? null,
  takenBy: o.takenBy ?? null,
  since: o.since ?? ago(2 * DAY()),
})

const noCollisions: SessionGroup[] = []

const byId = (proposals: RoutingProposal[]) => new Map(proposals.map((p) => [p.ticketId, p]))

void (async () => {
  // ── the clear cases route ─────────────────────────────────────────────────────────────────────────────────
  await t('a lone live board agent gets the ticket assigned (high, rule)', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-shop', projectId: 'shop', board: 'shop', status: STATUS_NEW, note: 'Скидка в корзине считается неверно' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-shop')!
    assert.equal(p.kind, 'assign')
    assert.equal(p.suggestedAgent, 'shopkeeper')
    assert.equal(p.confidence, 'high')
    assert.equal(p.source, 'rule')
    assert.equal(plan.usedLlm, false)
  })

  // ── the stuck ones get nudged, not touched ────────────────────────────────────────────────────────────────
  await t('a ticket taken >3d ago is nudged at its holder (never verified/rejected)', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-stuck', projectId: 'shop', status: STATUS_TAKEN, takenBy: 'shopkeeper', since: ago(STUCK_TAKEN_MS + DAY()) })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-stuck')!
    assert.equal(p.kind, 'nudge')
    assert.equal(p.suggestedAgent, 'shopkeeper')
    assert.equal(p.confidence, 'high')
  })

  await t('a freshly taken ticket is left alone (no proposal at all)', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-inprog', projectId: 'shop', status: STATUS_TAKEN, takenBy: 'shopkeeper', since: ago(DAY()) })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    assert.equal(plan.proposals.length, 0, 'healthy in-progress work needs no manager attention')
  })

  await t('a needs_review ticket waiting >2d nudges the filer, and does NOT accept it', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-rev', projectId: 'shop', status: STATUS_NEEDS_REVIEW, assignee: 'shopkeeper', since: ago(STUCK_REVIEW_MS + DAY()) })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-rev')!
    assert.equal(p.kind, 'nudge', 'the manager may only nudge — verifying is the filer/owner call')
  })

  // ── a collision is flagged, never worked around ───────────────────────────────────────────────────────────
  await t('a ticket held by a colliding handle escalates (collision beats a plain nudge)', async () => {
    const collisions: SessionGroup[] = [{ agent: 'ops', count: 2, lastSeen: NOW, sessions: [] }]
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-coll', projectId: 'infra', status: STATUS_TAKEN, takenBy: 'ops', since: ago(STUCK_TAKEN_MS + DAY()) })],
      roster,
      collisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-coll')!
    assert.equal(p.kind, 'escalate')
    assert.match(p.reason, /процесс/)
  })

  // ── the ambiguous one escalates by default — the no-LLM honesty proof ──────────────────────────────────────
  await t('with NO llm, two equal board candidates escalate instead of a guess', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-amb', projectId: 'design', board: 'design', status: STATUS_NEW, note: 'Поправить отступы' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-amb')!
    assert.equal(p.kind, 'escalate', 'ambiguity must not be resolved by inventing a routing')
    assert.equal(p.confidence, 'low')
    assert.equal(p.source, 'rule')
    assert.equal(plan.usedLlm, false)
    assert.equal(p.suggestedAgent, undefined)
  })

  await t('a board with no active agent escalates (nobody to assign to)', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-orphan', projectId: 'unknown', board: 'unknown', status: STATUS_NEW, note: 'что-то' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-orphan')!
    assert.equal(p.kind, 'escalate')
    assert.equal(p.confidence, 'low')
  })

  await t('a board whose only bound agent is silent escalates rather than routing to a ghost', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-stale', projectId: 'stale', board: 'stale', status: STATUS_NEW, note: 'что-то' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-stale')!
    assert.equal(p.kind, 'escalate')
    assert.match(p.reason, /молчит/)
  })

  // ── leave: deliberate no-action ───────────────────────────────────────────────────────────────────────────
  await t('a freshly filed unclaimed ticket is left for the board to self-claim', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-fresh', projectId: 'shop', status: STATUS_NEW, note: 'Скидка неверна', since: ago(ROUTE_AFTER_MS - 60_000) })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    const p = byId(plan.proposals).get('T-fresh')!
    assert.equal(p.kind, 'leave')
  })

  await t('an already-addressed live ticket is left alone', async () => {
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-addr', projectId: 'shop', status: STATUS_NEW, assignee: 'shopkeeper', since: ago(3 * DAY()) })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    assert.equal(byId(plan.proposals).get('T-addr')!.kind, 'leave')
  })

  // ── the llm hook, when present, decides ambiguous cases ────────────────────────────────────────────────────
  await t('an llm hook resolves the ambiguous ticket to a valid handle (low, llm)', async () => {
    const llm: ManagerLLM = async (prompt) => {
      assert.match(prompt, /design-a/, 'the prompt carries the candidate roster')
      return 'design-b'
    }
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-amb', projectId: 'design', board: 'design', status: STATUS_NEW, note: 'Поправить отступы' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state, llm)
    const p = byId(plan.proposals).get('T-amb')!
    assert.equal(p.kind, 'assign')
    assert.equal(p.suggestedAgent, 'design-b')
    assert.equal(p.confidence, 'low')
    assert.equal(p.source, 'llm')
    assert.equal(plan.usedLlm, true)
  })

  await t('an llm hook returning "escalate" hands the ticket to the owner, not a guess', async () => {
    const llm: ManagerLLM = async () => 'escalate'
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-amb', projectId: 'design', board: 'design', status: STATUS_NEW, note: 'x' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state, llm)
    const p = byId(plan.proposals).get('T-amb')!
    assert.equal(p.kind, 'escalate')
    assert.equal(p.source, 'llm')
  })

  await t('an llm hook returning garbage does not route to a non-existent agent — it escalates', async () => {
    const llm: ManagerLLM = async () => 'nobody-real'
    const state: ManagerState = {
      tickets: [ticket({ id: 'T-amb', projectId: 'design', board: 'design', status: STATUS_NEW, note: 'x' })],
      roster,
      collisions: noCollisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state, llm)
    const p = byId(plan.proposals).get('T-amb')!
    assert.equal(p.kind, 'escalate')
    assert.equal(p.suggestedAgent, undefined)
  })

  // ── the boundary — as code, not comment ───────────────────────────────────────────────────────────────────
  await t('managerMayAct allows only assign and nudge; every forbidden verb is refused', () => {
    assert.equal(managerMayAct('assign'), true)
    assert.equal(managerMayAct('nudge'), true)
    assert.equal(managerMayAct('escalate'), false, 'escalate is a hand-off, not an action the manager applies')
    assert.equal(managerMayAct('leave'), false)
    for (const forbidden of MANAGER_FORBIDDEN) {
      assert.equal(managerMayAct(forbidden), false, `${forbidden} must never be applicable`)
    }
  })

  await t('a proposal of a forbidden kind can NEVER be marked applicable', () => {
    // Even if some future caller forges a proposal with a forbidden action kind, isApplicable must reject it.
    for (const forbidden of ['verified', 'rejected', 'money', 'prod', 'publish']) {
      assert.equal(isApplicable({ kind: forbidden as RoutingKind }), false, `${forbidden} forged as a kind is not applicable`)
    }
  })

  await t('across a full mixed board the manager never emits an applicable forbidden action', async () => {
    const collisions: SessionGroup[] = [{ agent: 'ops', count: 3, lastSeen: NOW, sessions: [] }]
    const state: ManagerState = {
      tickets: [
        ticket({ id: 'A', projectId: 'shop', status: STATUS_NEW, note: 'Скидка неверна', since: ago(3 * DAY()) }),
        ticket({ id: 'B', projectId: 'shop', status: STATUS_TAKEN, takenBy: 'shopkeeper', since: ago(STUCK_TAKEN_MS + DAY()) }),
        ticket({ id: 'C', projectId: 'design', board: 'design', status: STATUS_NEW, note: 'отступы', since: ago(3 * DAY()) }),
        ticket({ id: 'D', projectId: 'infra', status: STATUS_TAKEN, takenBy: 'ops', since: ago(DAY()) }),
        ticket({ id: 'E', projectId: 'nowhere', board: 'nowhere', status: STATUS_NEW, note: 'x', since: ago(3 * DAY()) }),
        ticket({ id: 'F', projectId: 'shop', status: STATUS_NEEDS_REVIEW, assignee: 'shopkeeper', since: ago(STUCK_REVIEW_MS + DAY()) }),
      ],
      roster,
      collisions,
      now: NOW,
    }
    const plan = await computeRoutingPlan(state)
    // Every proposal is one of the four kinds, and applicable ones are only assign/nudge.
    for (const p of plan.proposals) {
      assert.ok(['assign', 'nudge', 'escalate', 'leave'].includes(p.kind), `unexpected kind ${p.kind}`)
      if (isApplicable(p)) assert.ok(p.kind === 'assign' || p.kind === 'nudge', 'only assign/nudge are applicable')
    }
    // The clear one routed, the stuck one nudged, the ambiguous+collision+orphan escalated.
    const m = byId(plan.proposals)
    assert.equal(m.get('A')!.kind, 'assign')
    assert.equal(m.get('B')!.kind, 'nudge')
    assert.equal(m.get('C')!.kind, 'escalate')
    assert.equal(m.get('D')!.kind, 'escalate') // ops is colliding
    assert.equal(m.get('E')!.kind, 'escalate')
    assert.equal(m.get('F')!.kind, 'nudge')
    // Sorted attention-first: escalates lead, leaves (if any) trail.
    const ranks = plan.proposals.map((p) => ({ escalate: 0, nudge: 1, assign: 2, leave: 3 })[p.kind])
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i]! >= ranks[i - 1]!, 'proposals are ordered by attention')
  })

  await t('buildRoutingPrompt lists the candidates and the escalate escape hatch', () => {
    const p = buildRoutingPrompt(
      ticket({ id: 'x', projectId: 'design', board: 'design', status: STATUS_NEW, note: 'note' }),
      [roster[2]!, roster[3]!],
    )
    assert.match(p, /design-a/)
    assert.match(p, /design-b/)
    assert.match(p, /escalate/)
  })

  console.log(`manager.test.ts: ${passed} passed`)
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
