// The stats aggregates against a REAL database file, because their whole job is to count rows correctly and that
// cannot be reasoned about from the types. Every number below is hand-counted from the fixtures seeded above it.
//
// Run: npx tsx packages/db/src/stats.test.ts   (writes a throwaway DB under the OS temp dir)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-stats-')), 'th.db')
process.env.SQLITE_FILE = file

const { repo, SESSION_LIVE_MS, SILENT_AGENT_MS } = await import('./index.ts')

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed++
  void name
}

// The current writer's arrow (U+2192, spaced). One fixture uses the ASCII legacy form to prove the suffix match
// counts both — see movedIntoLike in db.ts.
const A = ' → '

const project = repo.createProject('stats-test')
const P = project.id

// ── roster: the agents whose activity we will count ─────────────────────────────────────────────────────────
// owner + extension are seeded by the schema; these three register themselves like real agents do.
repo.upsertAgent({ handle: 'alice', title: 'Alice', role: 'Files and reviews.', board: P })
repo.upsertAgent({ handle: 'bob', title: 'Bob', role: 'Executes.', board: P })
repo.upsertAgent({ handle: 'carol', title: 'Carol', role: 'Reviews.', board: P })

// ── reports ─────────────────────────────────────────────────────────────────────────────────────────────────
// R1..R3 are alice→bob work; R4..R6 are owner captures addressed to nobody (the orphan fixtures).
const R1 = repo.createReport({ projectId: P, note: 'r1', creator: 'alice', assignee: 'bob' })
const R2 = repo.createReport({ projectId: P, note: 'r2', creator: 'alice', assignee: 'bob' })
const R3 = repo.createReport({ projectId: P, note: 'r3', creator: 'alice', assignee: 'bob' })
const R4 = repo.createReport({ projectId: P, note: 'orphan', creator: 'owner', via: 'extension' })
const R5 = repo.createReport({ projectId: P, note: 'declined', creator: 'owner', via: 'extension' })
const R6 = repo.createReport({ projectId: P, note: 'archived-orphan', creator: 'owner', via: 'extension' })

// current report states (drive the `holding` and `orphans` reads)
repo.setStatus(R3.id, 'taken'); repo.setTaken(R3.id, 'bob')   // R3: bob is actively holding it
repo.setStatus(R1.id, 'verified')                              // R1: accepted (taken_by bob, but done)
repo.setTaken(R1.id, 'bob')
repo.setStatus(R2.id, 'rejected')                             // R2: sent back (taken_by bob, but not holding)
repo.setTaken(R2.id, 'bob')
repo.setStatus(R5.id, 'wontfix')                             // R5: settled, so NOT an orphan
repo.setArchived(R6.id, true)                                // R6: hidden, so NOT an orphan

// ── journal ─────────────────────────────────────────────────────────────────────────────────────────────────
// created (6)
repo.logEvent({ projectId: P, reportId: R1.id, kind: 'created', actor: 'alice', detail: 'filed' })
repo.logEvent({ projectId: P, reportId: R2.id, kind: 'created', actor: 'alice', detail: 'filed' })
repo.logEvent({ projectId: P, reportId: R3.id, kind: 'created', actor: 'alice', detail: 'filed' })
repo.logEvent({ projectId: P, reportId: R4.id, kind: 'created', actor: 'owner', detail: 'filed' })
repo.logEvent({ projectId: P, reportId: R5.id, kind: 'created', actor: 'owner', detail: 'filed' })
repo.logEvent({ projectId: P, reportId: R6.id, kind: 'created', actor: 'owner', detail: 'filed' })
// status (8) — bob takes and hands to review, alice accepts one and rejects one, plus one legacy-arrow accept
repo.logEvent({ projectId: P, reportId: R1.id, kind: 'status', actor: 'bob', detail: `new${A}taken` })
repo.logEvent({ projectId: P, reportId: R1.id, kind: 'status', actor: 'bob', detail: `taken${A}needs_review` })
repo.logEvent({ projectId: P, reportId: R1.id, kind: 'status', actor: 'alice', detail: `needs_review${A}verified` })
repo.logEvent({ projectId: P, reportId: R2.id, kind: 'status', actor: 'bob', detail: `new${A}taken` })
repo.logEvent({ projectId: P, reportId: R2.id, kind: 'status', actor: 'bob', detail: `taken${A}needs_review` })
repo.logEvent({ projectId: P, reportId: R2.id, kind: 'status', actor: 'alice', detail: `needs_review${A}rejected` })
repo.logEvent({ projectId: P, reportId: R3.id, kind: 'status', actor: 'bob', detail: `new${A}taken` })
repo.logEvent({ projectId: P, reportId: R1.id, kind: 'status', actor: 'carol', detail: 'new -> verified' }) // legacy ASCII arrow
// comment (1) — an unnamed actor, the system-health signal-quality fixture
repo.logEvent({ projectId: P, reportId: R4.id, kind: 'comment', actor: 'extension', detail: 'auto' })
// total journal so far: 6 + 8 + 1 = 15

// ── agentActivity ───────────────────────────────────────────────────────────────────────────────────────────
const byAgent = (rows: { agent: string }[]) => new Map(rows.map((r) => [r.agent, r]))

t('agentActivity counts each handle from the journal + current holdings', () => {
  const m = byAgent(repo.agentActivity())
  const alice = m.get('alice')!
  assert.equal(alice.filed, 3, 'alice filed R1..R3')
  assert.equal(alice.accepted, 1, 'alice accepted R1')
  assert.equal(alice.rejected, 1, 'alice rejected R2')
  assert.equal(alice.taken, 0)
  assert.equal(alice.handedToReview, 0)
  assert.equal(alice.holding, 0, 'alice holds nothing')

  const bob = m.get('bob')!
  assert.equal(bob.filed, 0)
  assert.equal(bob.taken, 3, 'bob took R1, R2, R3')
  assert.equal(bob.handedToReview, 2, 'bob handed R1, R2 to review')
  assert.equal(bob.accepted, 0)
  assert.equal(bob.holding, 1, 'only R3 is still on bob’s plate (taken); R1 verified, R2 rejected')

  const owner = m.get('owner')!
  assert.equal(owner.filed, 3, 'owner filed R4..R6')
  assert.equal(owner.holding, 0)

  const carol = m.get('carol')!
  assert.equal(carol.accepted, 1, 'the ASCII-arrow legacy detail is still counted as a move into verified')

  assert.ok(m.has('extension'), 'an actor that only commented still gets a row')
  assert.equal(m.get('extension')!.filed, 0)
})

t('agentActivity lastEventAt is the true last time each acted, and rows sort by it', () => {
  const rows = repo.agentActivity()
  for (const r of rows) assert.ok(r.lastEventAt && r.lastEventAt > 0, `${r.agent} has a last event time`)
  for (let i = 1; i < rows.length; i++) {
    assert.ok((rows[i - 1].lastEventAt ?? 0) >= (rows[i].lastEventAt ?? 0), 'newest activity first')
  }
})

t('agentActivity window narrows the action counts but not holdings', () => {
  // A zero-length window is entirely in the past, so no event falls inside it.
  const m = byAgent(repo.agentActivity(0))
  const bob = m.get('bob')
  // bob may be absent from the windowed counts, but if present its action counts are zero and holding survives.
  if (bob) {
    assert.equal(bob.taken, 0, 'no windowed events')
    // holding is a current-state read, unaffected by the window
    assert.equal(bob.holding, 1, 'bob still holds R3 regardless of window')
  }
})

// ── flowByDay ───────────────────────────────────────────────────────────────────────────────────────────────
t('flowByDay buckets created vs verified per UTC day', () => {
  const days = repo.flowByDay(7)
  const created = days.reduce((n, d) => n + d.created, 0)
  const verified = days.reduce((n, d) => n + d.verified, 0)
  assert.equal(created, 6, 'six created events in the window')
  assert.equal(verified, 2, 'two moves into verified (one arrow, one legacy)')
  for (const d of days) assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/, 'day is a YYYY-MM-DD bucket')
})

// ── orphans ─────────────────────────────────────────────────────────────────────────────────────────────────
t('orphans is the stuck pile: unaddressed and unresolved, excluding wontfix and archived', () => {
  const o = repo.orphans()
  assert.equal(o.length, 1, 'only R4 qualifies — R5 is wontfix, R6 is archived, R1..R3 are addressed')
  assert.equal(o[0].id, R4.id)
  assert.equal(o[0].shortId, R4.shortId)
  assert.ok(o[0].ageMs >= 0, 'age is a non-negative span off created_at')
})

// ── sessions ────────────────────────────────────────────────────────────────────────────────────────────────
const T0 = Date.now()
repo.openSession({ sessionId: 'S1', agent: 'bob', projectId: P, origin: 'wt-1', startedAt: T0 })
repo.openSession({ sessionId: 'S2', agent: 'BOB', projectId: P, origin: 'wt-2', startedAt: T0 }) // uppercase folds to bob
repo.openSession({ sessionId: 'S3', agent: 'alice', projectId: P, origin: 'wt-a', startedAt: T0 })

t('liveSessions returns a handle’s live sessions, and folds the handle to canonical', () => {
  assert.equal(repo.liveSessions('bob').length, 2, 'S1 + S2, the second opened as "BOB"')
  assert.equal(repo.liveSessions('alice').length, 1)
  assert.equal(repo.liveSessions('nobody').length, 0)
})

t('sessionsByAgent groups per handle; a handle with >1 live session is a collision', () => {
  const groups = repo.sessionsByAgent()
  const bob = groups.find((g) => g.agent === 'bob')!
  assert.equal(bob.count, 2)
  assert.equal(bob.sessions.length, 2)
  const alice = groups.find((g) => g.agent === 'alice')!
  assert.equal(alice.count, 1)
  const collisions = groups.filter((g) => g.count > 1).map((g) => g.agent)
  assert.deepEqual(collisions, ['bob'], 'exactly one collision, under bob')
})

t('openSession stamps started_at once and does not blank origin on an empty re-open', () => {
  repo.openSession({ sessionId: 'S1', agent: 'bob', startedAt: T0 + 5_000, origin: '' })
  const s1 = repo.liveSessions('bob').find((s) => s.sessionId === 'S1')!
  assert.equal(s1.startedAt, T0, 'reconnect keeps the original start time')
  assert.equal(s1.origin, 'wt-1', 'an empty origin on re-open does not erase the one already set')
})

t('touchSession moves a known session and reports a miss for an unknown one', () => {
  assert.equal(repo.touchSession('S1'), true)
  assert.equal(repo.touchSession('does-not-exist'), false, 'no silent auto-create')
})

// ── system health (with all three sessions live) ────────────────────────────────────────────────────────────
t('systemHealth counts journal size, unnamed actors, live sessions and collisions', () => {
  const h = repo.systemHealth()
  assert.equal(h.journalSize, 15, '6 created + 8 status + 1 comment')
  assert.equal(h.unnamedActorEvents, 1, 'only the extension-authored comment')
  assert.equal(h.liveSessions, 3, 'S1 + S2 + S3')
  assert.equal(h.collisions, 1)
  assert.deepEqual(h.collidingAgents, ['bob'])
  assert.equal(h.silentAgents, 0, 'every rostered agent acted just now')
})

// ── session liveness window ─────────────────────────────────────────────────────────────────────────────────
// Backdate S3 past the live window with a second connection — the repo has no "set last_seen to the past" verb,
// and inventing one only for a test would widen the surface the next stages build on.
const raw = new DatabaseSync(file)
raw.prepare('UPDATE agent_sessions SET last_seen = ? WHERE session_id = ?').run(Date.now() - (SESSION_LIVE_MS + 60_000), 'S3')

t('a session past the live window drops out, and a wider window brings it back', () => {
  assert.equal(repo.liveSessions('alice').length, 0, 'S3 aged out of the default 10-minute window')
  assert.equal(repo.liveSessions('alice', 60 * 60 * 1000).length, 1, 'a 1-hour window still sees it')
  assert.ok(!repo.sessionsByAgent().some((g) => g.agent === 'alice'), 'and it is gone from the collision view')
})

// ── silent agents ───────────────────────────────────────────────────────────────────────────────────────────
repo.upsertAgent({ handle: 'ghost', title: 'Ghost', role: 'Went quiet.', board: P })
raw.prepare('UPDATE agents SET last_seen = ? WHERE handle = ?').run(Date.now() - (SILENT_AGENT_MS + 60_000), 'ghost')

t('systemHealth flags an active agent that has gone silent past the threshold', () => {
  const h = repo.systemHealth()
  assert.equal(h.silentAgents, 1)
  assert.deepEqual(h.silentAgentHandles, ['ghost'])
})

// ── write-origin: the session column on events ──────────────────────────────────────────────────────────────
t('logEvent records an optional session that reads back, and null when absent', () => {
  repo.logEvent({ projectId: P, reportId: R1.id, kind: 'comment', actor: 'alice', detail: 'sess-check', session: 'S1' })
  repo.logEvent({ projectId: P, reportId: R1.id, kind: 'comment', actor: 'alice', detail: 'no-sess' })
  const all = repo.eventsSince(P, 0, 500)
  assert.equal(all.find((e) => e.detail === 'sess-check')!.session, 'S1')
  assert.equal(all.find((e) => e.detail === 'no-sess')!.session, null)
  // a pre-session row also reads back null, never a guess
  assert.equal(all.find((e) => e.detail === 'filed')!.session, null)
})

// ── report provenance: the via column ───────────────────────────────────────────────────────────────────────
t('createReport stores `via` and legacy/agent rows read back null', () => {
  assert.equal(repo.getReport(R4.id)!.via, 'extension', 'an extension capture keeps its channel')
  assert.equal(repo.getReport(R1.id)!.via, null, 'an agent-filed ticket has no via')
})

raw.close()
console.log(`db/stats: all ${passed} tests passed ✓`)
console.log(`(throwaway DB left at ${path.dirname(file)})`)
