// Dispatch plumbing against injected effects. Pure — no database, no network: applyAssign and wake are stubs that
// RECORD whether they were called, so "OFF blocks waking" is proven by the stub never firing, not by inspecting a
// return string. This is the safety the whole night rests on, so it is tested first and hardest.
//
// Run: npx tsx apps/web/lib/dispatch.test.ts
import assert from 'node:assert/strict'
import {
  dispatchProposal,
  dispatchAll,
  buildWakeMessage,
  type ApplyAssign,
  type WakeSender,
  type DispatchTicket,
} from './dispatch.ts'
import type { RoutingProposal, RoutingKind } from './manager.ts'
import type { AutonomyMode } from '@th/db'

let passed = 0
function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++
    void name
  })
}

const ticket: DispatchTicket = { shortId: 'ab12cd34', note: 'корзина теряет позицию', board: 'shop' }

const assignProposal = (over: Partial<RoutingProposal> = {}): RoutingProposal => ({
  kind: 'assign',
  ticketId: 'id-1',
  shortId: 'ab12cd34',
  reason: 'единственный живой исполнитель доски',
  suggestedAgent: 'shop-a',
  confidence: 'high',
  source: 'rule',
  ...over,
})

// A stub that records calls, so a test can assert an effect NEVER fired (the point of the OFF gate).
function recordingApply(result: Awaited<ReturnType<ApplyAssign>> = { ok: true }): { fn: ApplyAssign; calls: RoutingProposal[] } {
  const calls: RoutingProposal[] = []
  return { calls, fn: async (p) => { calls.push(p); return result } }
}
function recordingWake(result: Awaited<ReturnType<WakeSender>> = { delivered: true, detail: 'session shop-a' }): { fn: WakeSender; calls: Array<{ target: string; message: string }> } {
  const calls: Array<{ target: string; message: string }> = []
  return { calls, fn: async (target, message) => { calls.push({ target, message }); return result } }
}

;(async () => {
  // ── THE GATE: OFF blocks EVERY effect ─────────────────────────────────────────────────────────────────────
  await t('autonomy OFF applies nothing and wakes nothing', async () => {
    const apply = recordingApply()
    const wake = recordingWake()
    const r = await dispatchProposal({ proposal: assignProposal(), ticket, autonomy: 'off', applyAssign: apply.fn, wake: wake.fn })
    assert.equal(r.decision, 'autonomy-off')
    assert.equal(r.applied, false)
    assert.equal(r.poked, false)
    assert.equal(apply.calls.length, 0, 'OFF must not touch the board')
    assert.equal(wake.calls.length, 0, 'OFF must not poke a session')
  })

  await t('an unset/garbage mode is treated as OFF by the caller contract (only "on" acts)', async () => {
    const apply = recordingApply()
    // The type is AutonomyMode, but resolveAutonomy is the only producer and it never emits anything but on|off;
    // still, dispatch keys off === 'on', so any non-'on' is inert. Cast a garbage value to prove the guard.
    const r = await dispatchProposal({ proposal: assignProposal(), ticket, autonomy: 'maybe' as unknown as AutonomyMode, applyAssign: apply.fn })
    assert.equal(r.decision, 'autonomy-off')
    assert.equal(apply.calls.length, 0)
  })

  // ── THE BOUNDARY: only an applicable assign reaches an effect ──────────────────────────────────────────────
  for (const kind of ['nudge', 'escalate', 'leave'] as RoutingKind[]) {
    await t(`ON but kind=${kind} is not applied (dispatcher acts on assigns only)`, async () => {
      const apply = recordingApply()
      const r = await dispatchProposal({ proposal: assignProposal({ kind }), ticket, autonomy: 'on', applyAssign: apply.fn })
      assert.equal(r.decision, 'not-applicable')
      assert.equal(apply.calls.length, 0)
    })
  }

  await t('a FORGED forbidden kind is refused by the boundary even ON', async () => {
    const apply = recordingApply()
    // isApplicable(managerMayAct) is false for anything outside assign|nudge; a hand-forged 'verify' never applies.
    const forged = assignProposal({ kind: 'verify' as unknown as RoutingKind })
    const r = await dispatchProposal({ proposal: forged, ticket, autonomy: 'on', applyAssign: apply.fn })
    assert.equal(r.decision, 'not-applicable')
    assert.equal(apply.calls.length, 0, 'a forbidden verb never reaches the board')
  })

  await t('an assign without a target applies nothing', async () => {
    const apply = recordingApply()
    const r = await dispatchProposal({ proposal: assignProposal({ suggestedAgent: undefined }), ticket, autonomy: 'on', applyAssign: apply.fn })
    assert.equal(r.decision, 'no-target')
    assert.equal(apply.calls.length, 0)
  })

  // ── EFFECTS when ON ───────────────────────────────────────────────────────────────────────────────────────
  await t('ON, no wake channel: assign is applied, board-native wake only, poke NOT faked', async () => {
    const apply = recordingApply()
    const r = await dispatchProposal({ proposal: assignProposal(), ticket, autonomy: 'on', applyAssign: apply.fn })
    assert.equal(apply.calls.length, 1, 'the board write happened')
    assert.equal(r.applied, true)
    assert.equal(r.decision, 'applied-board-wake')
    assert.equal(r.poked, false, 'no channel => no claimed poke')
  })

  await t('ON, attended wake delivers: assign applied AND session poked with the three-move message', async () => {
    const apply = recordingApply()
    const wake = recordingWake({ delivered: true, detail: 'session shop-a' })
    const r = await dispatchProposal({ proposal: assignProposal(), ticket, autonomy: 'on', applyAssign: apply.fn, wake: wake.fn })
    assert.equal(r.decision, 'applied-and-poked')
    assert.equal(r.poked, true)
    assert.equal(wake.calls.length, 1)
    assert.equal(wake.calls[0]!.target, 'shop-a')
    assert.match(wake.calls[0]!.message, /get_report ab12cd34/)
    assert.match(wake.calls[0]!.message, /submit_report/)
  })

  await t('ON, wake channel present but NOT delivered: falls back to board wake, never claims a poke', async () => {
    const apply = recordingApply()
    const wake = recordingWake({ delivered: false, detail: 'no live session for shop-a' })
    const r = await dispatchProposal({ proposal: assignProposal(), ticket, autonomy: 'on', applyAssign: apply.fn, wake: wake.fn })
    assert.equal(r.applied, true)
    assert.equal(r.poked, false)
    assert.equal(r.decision, 'applied-board-wake')
    assert.match(r.detail, /не дошёл/)
  })

  await t('ON, board write FAILS: surfaced as apply-failed, wake never attempted', async () => {
    const apply = recordingApply({ ok: false, error: 'bad_project_key' })
    const wake = recordingWake()
    const r = await dispatchProposal({ proposal: assignProposal(), ticket, autonomy: 'on', applyAssign: apply.fn, wake: wake.fn })
    assert.equal(r.decision, 'apply-failed')
    assert.equal(r.applied, false)
    assert.equal(wake.calls.length, 0, 'no wake after a failed write')
    assert.match(r.detail, /bad_project_key/)
  })

  // ── BATCH ─────────────────────────────────────────────────────────────────────────────────────────────────
  await t('dispatchAll OFF applies nothing across a whole batch', async () => {
    const apply = recordingApply()
    const items = [
      { proposal: assignProposal({ ticketId: 'a', shortId: 'aaa' }), ticket },
      { proposal: assignProposal({ ticketId: 'b', shortId: 'bbb' }), ticket },
    ]
    const out = await dispatchAll(items, { autonomy: 'off', applyAssign: apply.fn })
    assert.equal(out.length, 2)
    assert.ok(out.every((r) => r.decision === 'autonomy-off'))
    assert.equal(apply.calls.length, 0)
  })

  await t('dispatchAll ON applies each assign in order', async () => {
    const apply = recordingApply()
    const items = [
      { proposal: assignProposal({ ticketId: 'a', shortId: 'aaa' }), ticket },
      { proposal: assignProposal({ ticketId: 'b', shortId: 'bbb', kind: 'escalate' }), ticket }, // refused by boundary
    ]
    const out = await dispatchAll(items, { autonomy: 'on', applyAssign: apply.fn })
    assert.equal(apply.calls.length, 1, 'only the assign was applied')
    assert.equal(out[0]!.decision, 'applied-board-wake')
    assert.equal(out[1]!.decision, 'not-applicable')
  })

  await t('buildWakeMessage names the ticket and omits an empty summary', () => {
    const withNote = buildWakeMessage(ticket)
    assert.match(withNote, /Summary: корзина теряет позицию/)
    const noNote = buildWakeMessage({ shortId: 'ff00', note: '   ', board: 'infra' })
    assert.doesNotMatch(noNote, /Summary:/)
    assert.match(noNote, /get_report ff00/)
  })

  console.log(`dispatch.test.ts: ${passed} passed`)
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
