import assert from 'node:assert/strict'
import { buildConnectSnippet, buildInstructions, ONBOARDING_TOOLS, REPO_PATH_PLACEHOLDER } from './onboarding'
import { STATUSES, UPDATE_FILTERS, type RosterEntry } from './index'

//   npx tsx packages/db/src/onboarding.test.ts
//
// What is under test is not prose but the claim the module makes: that the greeting is COMPOSED from the enforcing
// constants. So the checks are mechanical — every status the lifecycle has, every journal filter, every tool named
// — and they fail the day somebody adds a seventh status without telling the agents about it.

const ROSTER: RosterEntry[] = [
  { handle: 'owner', title: 'Владелец доски', role: 'Ставит задачи и выносит окончательное решение.', active: true },
  { handle: 'mcp-core', title: 'MCP-ядро', role: 'Owns the MCP servers and their contract; does not touch the dashboard.', active: true },
  { handle: 'gone', title: 'Retired', role: 'Ушёл.', active: false },
]

const full = buildInstructions({
  boardName: 'eRENTAL',
  identity: { kind: 'declared', identity: 'mcp-core' },
  roster: { kind: 'known', agents: ROSTER },
})

// ── the whole enforced vocabulary reaches the agent ─────────────────────────────────────────────────────────
for (const s of STATUSES) assert.ok(full.includes(s), `the lifecycle status "${s}" is never named in the instructions`)
for (const f of UPDATE_FILTERS) assert.ok(full.includes(f), `the update filter "${f}" is never named in the instructions`)
for (const t of Object.values(ONBOARDING_TOOLS)) assert.ok(full.includes(t), `tool "${t}" is declared but never named`)

// The four-part work report is the rule agents break most; naming three of four would read as complete.
for (const part of ['comment', 'verifyUrl', 'verifySteps', 'evidence']) {
  assert.ok(full.includes(part), `the work report part "${part}" is missing from the instructions`)
}
assert.match(full, /not_your_call/, 'the refusal an executor will actually hit is named, not paraphrased')

// ── the board and the colleagues are the live ones, not a template ──────────────────────────────────────────
assert.match(full, /"eRENTAL"/, 'the board is named')
assert.match(full, /mcp-core \(MCP-ядро\) — Owns the MCP servers/, 'a colleague is introduced by handle, title and role')
assert.ok(!full.includes('gone'), 'a retired agent is not offered as somebody to hand work to')
assert.match(full, /YOU ARE "mcp-core"/, 'a declared identity is stated as a fact, with no warning attached')

// ── the three things that must be said when the agent has no name ───────────────────────────────────────────
const anonymous = buildInstructions({
  boardName: 'eRENTAL',
  identity: { kind: 'fallback', signedAs: 'erental' },
  roster: { kind: 'known', agents: ROSTER },
})
assert.match(anonymous, /NO IDENTITY/, 'the missing identity is stated')
assert.match(anonymous, /signed with "erental"/, 'and what the writes are signed with instead')
assert.match(anonymous, /TH_AGENT=<your-handle>/, 'and the fix, in the form it is typed')

// An unreadable roster and an empty one must not read alike: one means "you are first", the other "you have not
// seen your colleagues". This is the distinction the remote server depends on when its collector is down.
const blind = buildInstructions({
  boardName: null,
  identity: { kind: 'unknown' },
  roster: { kind: 'unreadable', reason: 'connect ECONNREFUSED 127.0.0.1:9' },
})
assert.match(blind, /could not be read \(connect ECONNREFUSED/, 'the reason travels with the failure')
assert.match(blind, new RegExp(`call ${ONBOARDING_TOOLS.listAgents}`), 'and it says what to do about it')

const empty = buildInstructions({ boardName: 'fresh', identity: { kind: 'unknown' }, roster: { kind: 'known', agents: [] } })
assert.match(empty, /nobody yet — you would be the first/, 'an empty board invites the first agent in')
assert.ok(!empty.includes('could not be read'), 'an empty board is never reported as a failure')

// ── it stays cheap enough to inject into every context ──────────────────────────────────────────────────────
const BUDGET = 2600
assert.ok(full.length < BUDGET, `the greeting is ${full.length} chars — over the ${BUDGET} budget every request pays`)

// ── the connection snippet hands out no credential it was not already given ─────────────────────────────────
const snippet = buildConnectSnippet({ collector: 'https://qa.example', readKey: 'thr_abc123' })
assert.match(snippet, /TH_PROJECT_KEY=thr_abc123/, 'the read key the caller already holds is filled in')
assert.match(snippet, /TH_INGEST_KEY=<ingest key/, 'the WRITE key is a placeholder — a read key must not fetch it')
assert.ok(snippet.includes(REPO_PATH_PLACEHOLDER), 'and the checkout path is left blank rather than guessed')
assert.match(
  buildConnectSnippet({ collector: 'https://qa.example', readKey: 'thr_abc123', repoPath: '/srv/th' }),
  /-C "\/srv\/th"/,
  'a caller that knows the path can fill it in',
)

console.log(`onboarding.test: done ✓ (${full.length} chars of instructions)`)
