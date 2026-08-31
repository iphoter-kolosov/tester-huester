import type { AutonomyMode } from '@th/db'
import { isApplicable, type RoutingProposal } from './manager'

// DISPATCH — the plumbing that turns an APPROVED routing into an agent actually starting work. It is deliberately
// the thin, gated seam between the manager's judgment (manager.ts) and two real effects: writing the assign to the
// board, and poking a running session. Every effect is INJECTED, so this module holds only the decision — the same
// separation manager.ts keeps, and the reason both are testable without a database or a network.
//
// TWO THINGS HAVE TO BE TRUE before anything wakes:
//   1. the autonomy switch is ON (resolveAutonomy in @th/db) — OFF means advisory-only, and OFF blocks EVERY wake;
//   2. the proposal is one the manager may actually apply (isApplicable) AND is an assign — the boundary is
//      re-checked HERE, never trusted from upstream, so a forged 'verify'/'escalate' can never reach an effect.
//
// HOW AN AGENT IS ACTUALLY WOKEN — the honest two layers:
//   • BOARD-NATIVE (always available, no session tools): applying the assign writes an `assigned` journal event.
//     Any agent already running its `wait_for_updates` long-poll wakes on that event through its inbox filter.
//     This needs no cross-session capability at all, because the AGENT PULLS. Its limit is equally honest: it can
//     only feed a session that is ALREADY running and polling — it cannot START a stopped one.
//   • OUT-OF-BAND POKE (attended only): to reach a session that is idle at a prompt or not yet polling, you need
//     the harness SendMessage/ListAgents tools. Those are documented UNAVAILABLE in unattended/scheduled runs, so
//     a cron-launched dispatcher CANNOT deliver this poke. We model it as an injected `WakeSender` that is simply
//     ABSENT in an unattended context — and when it is absent we DO NOT pretend the poke happened; we fall back to
//     the board-native wake and say so. A dispatcher that claims to wake sessions it cannot reach is worse than none.

/** The minimal ticket facts the wake message needs — the surface projects these; dispatch stays DB-free. */
export type DispatchTicket = { shortId: string; note: string; board: string }

/** Apply an approved assign to the board (the PATCH assignee write). Injected so dispatch needs no HTTP/DB itself. */
export type ApplyAssign = (p: RoutingProposal) => Promise<ApplyOutcome>
export type ApplyOutcome = { ok: true } | { ok: false; error: string }

/**
 * The out-of-band poke to a live session (the SendMessage transport). Present ONLY when a human is at the wheel;
 * `undefined` in an unattended/cron context — and dispatch then falls back to the board-native wake, never fakes it.
 */
export type WakeSender = (target: string, message: string) => Promise<WakeOutcome>
export type WakeOutcome = { delivered: boolean; detail: string }

export type DispatchDecision =
  /** Switch OFF — advisory mode. Nothing applied, nothing woken. The default, and the safe one. */
  | 'autonomy-off'
  /** Not an applicable assign (escalate/leave/nudge, or a forged forbidden kind). The boundary refused. */
  | 'not-applicable'
  /** An assign with no addressee to route to — nothing to apply. */
  | 'no-target'
  /** The board write itself failed — surfaced loudly, never swallowed; no wake attempted. */
  | 'apply-failed'
  /** Assign written; the agent's own wait_for_updates loop is the wake. No out-of-band poke (none available). */
  | 'applied-board-wake'
  /** Assign written AND an out-of-band poke was delivered to a live session. */
  | 'applied-and-poked'

export type DispatchResult = {
  proposal: RoutingProposal
  decision: DispatchDecision
  /** Did work get pushed to a session BEYOND the board event (an out-of-band poke actually delivered)? */
  poked: boolean
  /** Was the assign written to the board at all? (An always-available wake for any polling agent.) */
  applied: boolean
  /** Owner-facing, Russian: what happened and, on failure, what to do. */
  detail: string
}

/**
 * The message handed to a woken agent — agent-facing, so English (house rule). It names the exact three moves the
 * board expects, so a session that receives it needs no other context to start: read, do, submit.
 */
export function buildWakeMessage(ticket: DispatchTicket): string {
  const summary = ticket.note.trim() ? ` Summary: ${ticket.note.trim().slice(0, 200)}` : ''
  return (
    `You have work on the "${ticket.board}" QA board: ticket ${ticket.shortId}. ` +
    `Call get_report ${ticket.shortId} to read it, do the work, then submit_report when it is ready for review.` +
    summary
  )
}

/**
 * Dispatch ONE approved proposal. The gate is checked before any effect and blocks every wake when OFF; the
 * boundary is re-checked before any effect and refuses anything but an applicable assign.
 */
export async function dispatchProposal(input: {
  proposal: RoutingProposal
  ticket: DispatchTicket
  autonomy: AutonomyMode
  applyAssign: ApplyAssign
  wake?: WakeSender
}): Promise<DispatchResult> {
  const { proposal, ticket, autonomy, applyAssign, wake } = input
  const base = { proposal, poked: false, applied: false }

  // GATE. OFF is advisory-only and blocks EVERY wake — this is the whole safety of the night.
  if (autonomy !== 'on') {
    return { ...base, decision: 'autonomy-off', detail: `«${proposal.shortId}»: автономный режим выключен — предложение только показано, ничего не применено.` }
  }

  // BOUNDARY. Only an applicable assign reaches an effect — a forged forbidden kind fails isApplicable, and any
  // non-assign (escalate/leave/nudge) is not this dispatcher's to act on. Both must hold.
  if (proposal.kind !== 'assign' || !isApplicable(proposal)) {
    return { ...base, decision: 'not-applicable', detail: `«${proposal.shortId}»: не назначение (${proposal.kind}) — диспетчер его не применяет; это ход владельца или поверхности.` }
  }

  if (!proposal.suggestedAgent) {
    return { ...base, decision: 'no-target', detail: `«${proposal.shortId}»: назначение без адресата — некому передать, применять нечего.` }
  }
  const target = proposal.suggestedAgent

  // EFFECT 1 — write the assign. This is itself the board-native wake for any agent already polling.
  const applied = await applyAssign(proposal)
  if (!applied.ok) {
    return { ...base, decision: 'apply-failed', detail: `«${proposal.shortId}»: запись назначения не прошла (${applied.error}) — ничего не разбужено; проверьте доску и повторите.` }
  }

  // EFFECT 2 — the out-of-band poke, ONLY if a channel exists. Absent channel => honest board-native fallback.
  if (!wake) {
    return {
      proposal,
      applied: true,
      poked: false,
      decision: 'applied-board-wake',
      detail: `«${proposal.shortId}» передан ${target}. Разбудит его собственный wait_for_updates; прямого канала, чтобы поднять неработающую сессию, из этого запуска нет.`,
    }
  }

  const poke = await wake(target, buildWakeMessage(ticket))
  if (poke.delivered) {
    return { proposal, applied: true, poked: true, decision: 'applied-and-poked', detail: `«${proposal.shortId}» передан ${target} и сессия разбужена напрямую (${poke.detail}).` }
  }
  // Channel existed but did not deliver (session not listed/asleep) — fall back honestly, do not claim a wake.
  return { proposal, applied: true, poked: false, decision: 'applied-board-wake', detail: `«${proposal.shortId}» передан ${target}, но прямой сигнал не дошёл (${poke.detail}) — ждём его wait_for_updates.` }
}

/**
 * Dispatch a batch — the shape a caller uses to apply "раздать всё уверенное" when autonomy is ON. Sequential on
 * purpose: each effect is a real board write, and a failure in one must not be hidden behind a parallel race. The
 * per-item gate/boundary still apply, so a non-assign slipping into the list is refused, not acted on.
 */
export async function dispatchAll(
  items: Array<{ proposal: RoutingProposal; ticket: DispatchTicket }>,
  ctx: { autonomy: AutonomyMode; applyAssign: ApplyAssign; wake?: WakeSender },
): Promise<DispatchResult[]> {
  const out: DispatchResult[] = []
  for (const it of items) {
    out.push(await dispatchProposal({ proposal: it.proposal, ticket: it.ticket, autonomy: ctx.autonomy, applyAssign: ctx.applyAssign, wake: ctx.wake }))
  }
  return out
}
