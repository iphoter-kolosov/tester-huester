// The board is several agents reading ONE journal. This file exists because the first version of that board gave
// them one shared position: whichever agent acked first moved the others past events they had never been shown,
// and because each agent's read is deliberately narrowed to its own slice, the loss was certain rather than
// unlikely — and silent on both sides.
//
// Run: npx tsx packages/db/src/cursors.test.ts   (writes a throwaway DB under the OS temp dir)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-cursors-'))
process.env.SQLITE_FILE = path.join(dir, 'cursors.db')

const { repo } = await import('./index.ts')

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed++
  void name
}

const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'
const NEWCOMER = 'agent-c'

const project = repo.createProject('cursors-test')

/** File a ticket and journal it the way the ingest route does, so the filters have something real to match. */
function fileTask(creator: string, assignee: string): void {
  const r = repo.createReport({ projectId: project.id, note: `${creator} → ${assignee}`, creator, assignee })
  repo.logEvent({ projectId: project.id, reportId: r.id, kind: 'created', actor: creator, detail: 'filed' })
}

fileTask(AGENT_A, AGENT_B)
fileTask(AGENT_B, AGENT_A)

t("one agent's ack does not move another agent's position — the defect this file was written for", () => {
  const readB = repo.eventsSinceFor(project.id, repo.getCursor(project.id, AGENT_B), AGENT_B, ['inbox'], 100)
  assert.equal(readB.events.length, 1, 'B is shown the ticket A filed for it')
  repo.setCursor(project.id, readB.scannedTo, AGENT_B)

  const readA = repo.eventsSinceFor(project.id, repo.getCursor(project.id, AGENT_A), AGENT_A, ['inbox'], 100)
  assert.equal(readA.events.length, 1, 'A is still shown the ticket B filed for it, after B acked')
})

t('an ack only ever moves forward, per agent', () => {
  const at = repo.getCursor(project.id, AGENT_B)
  assert.ok(at > 0, 'B has a position of its own by now')
  assert.equal(repo.setCursor(project.id, 0, AGENT_B), at, 'a late ack from a slow worker cannot rewind')
})

t('agent acks leave the shared position alone, so a client that never names itself is not dragged along', () => {
  assert.equal(repo.getCursor(project.id), 0)
})

t('an unnamed reader keeps the project position it always had', () => {
  assert.equal(repo.setCursor(project.id, 1), 1)
  assert.equal(repo.getCursor(project.id), 1)
})

t('an agent that has never acked starts where the board is, not at zero — adopting identities replays nothing', () => {
  assert.equal(repo.getCursor(project.id, NEWCOMER), 1)
})

t('a second ack under the same identity updates the row instead of failing on the primary key', () => {
  const next = repo.latestSeq(project.id)
  assert.equal(repo.setCursor(project.id, next, AGENT_B), next)
  assert.equal(repo.getCursor(project.id, AGENT_B), next)
})

t('positions are per project as well as per agent — one identity works several boards', () => {
  const other = repo.createProject('cursors-test-other')
  assert.equal(repo.getCursor(other.id, AGENT_B), 0, "B's position on a board it never read is that board's own")
})

console.log(`db/cursors: all ${passed} tests passed ✓`)
console.log(`(throwaway DB left at ${dir} — the connection lives for the process, so it cannot unlink itself)`)
