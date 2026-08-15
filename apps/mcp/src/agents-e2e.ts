import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The agent-to-agent loop, driven exactly as an agent drives it — over stdio, through the MCP server, against a
// throwaway database. Proves the half of the contract that cannot be read off the types: that the FILER of a
// ticket is the only agent allowed to accept the work, that a work report without proof is refused, and that both
// servers expose the same tools.
//
//   pnpm --filter @th/mcp exec tsx src/agents-e2e.ts
//
// Nothing here touches the real th.db: SQLITE_FILE is pointed at a temp file BEFORE @th/db is imported (hence the
// dynamic import — a static one would be hoisted above the assignment and open the wrong database).
const here = path.dirname(fileURLToPath(import.meta.url))
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-agents-')), 'th.db')
process.env.SQLITE_FILE = dbFile

const { repo } = await import('@th/db')
const project = repo.createProject('agents-e2e')

const FILER = 'filer-agent'
const EXECUTOR = 'executor-agent'
const THIRD = 'third-agent'
const LINK = 'https://example.test/screen?id=7'

function connect(entry: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, entry)],
    // The package directory, so `--import tsx` resolves however this script was launched from.
    cwd: path.join(here, '..'),
    env: { ...(process.env as Record<string, string>), ...env },
  })
  const client = new Client({ name: 'agents-e2e', version: '0.0.0' })
  return client.connect(transport).then(() => client)
}

const local = await connect('index.ts', { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey })

const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await local.callTool({ name, arguments: args })
  return (res.content as Array<{ type: string; text: string }>)[0]!.text
}

// ── an agent files work for another agent ───────────────────────────────────────────────────────────────────
const filed = await call('create_task', {
  assignee: EXECUTOR,
  title: 'Кнопка «Проверить» не открывает экран',
  body: 'На карточке тикета ссылка ведёт на корень сайта вместо конкретного экрана.',
  type: 'fix',
  severity: 'high',
  links: [LINK],
  agent: FILER,
})
const id = /id ([0-9a-f-]{36})$/.exec(filed.trim())?.[1]
assert.ok(id, `create_task returned an id: ${filed}`)
const row = repo.getReport(id)!
assert.equal(row.creator, FILER, 'the filer is recorded as creator')
assert.equal(row.assignee, EXECUTOR, 'the task is addressed to the executor')
assert.equal(row.pageUrl, LINK, 'the first link became the page URL')
assert.equal(row.type, 'fix')
assert.equal(row.severity, 'high')
assert.match(row.note, /Ссылки:/, 'the links block is in the note')

const badLink = await call('create_task', { assignee: EXECUTOR, title: 'x', body: 'y', links: ['/relative'], agent: FILER })
assert.match(badLink, /Not absolute http\(s\) links/, 'a relative link is refused, not silently dropped')
assert.equal(repo.listReports({ projectId: project.id }).length, 1, 'the refused task was not filed')

// ── each side sees its own plate ────────────────────────────────────────────────────────────────────────────
const plateExec = JSON.parse(await call('my_tasks', { agent: EXECUTOR })) as { assigned: { id: string }[]; filed: unknown[] }
assert.equal(plateExec.assigned.length, 1, 'the executor sees the task in its inbox')
assert.equal(plateExec.filed.length, 0, 'the executor did not file it')
const plateFiler = JSON.parse(await call('my_tasks', { agent: FILER })) as { assigned: unknown[]; filed: { id: string }[] }
assert.equal(plateFiler.filed[0]?.id, id, 'the filer sees it as theirs to accept')
assert.equal(plateFiler.assigned.length, 0, 'the filer is not the one doing it')

const inbox = JSON.parse(await call('get_updates', { agent: EXECUTOR, filter: ['inbox'] })) as { count: number; cursor: number }
assert.ok(inbox.count >= 1, 'the created event reaches the executor through the inbox filter')
assert.ok(inbox.cursor > 0, 'a filtered read still reports how far it scanned')
const strangerInbox = JSON.parse(await call('get_updates', { agent: THIRD, filter: ['inbox'] })) as { count: number; cursor: number }
assert.equal(strangerInbox.count, 0, 'an uninvolved agent sees nothing in its inbox')
assert.equal(strangerInbox.cursor, inbox.cursor, 'but it is told the same scan position — acking it drops nothing')

// ── the executor works and hands it back ────────────────────────────────────────────────────────────────────
assert.match(await call('set_status', { id, status: 'taken', agent: EXECUTOR }), /→ taken/, 'taking a ticket needs nothing else')
assert.equal(repo.getReport(id)!.takenBy, EXECUTOR, 'taking stamps the holder')

const noProof = await call('set_status', { id, status: 'needs_review', agent: EXECUTOR, comment: 'сделал', verifyUrl: LINK, verifySteps: ['открыть'] })
assert.match(noProof, /^evidence_required/, 'a work report without proof is refused')
assert.equal(repo.getReport(id)!.status, 'taken', 'and the refused transition changed nothing')

const submitted = await call('submit_report', {
  id,
  agent: EXECUTOR,
  comment: 'Ссылка строилась от корня. Теперь берётся pageUrl тикета. Коммит a1b2c3d.',
  verifyUrl: LINK,
  verifySteps: ['Открыть тикет', 'Нажать «Проверить»', 'Открывается тот самый экран'],
  evidence: 'verify.test.ts: 42 passed',
})
assert.match(submitted, /→ needs_review/, 'submit_report moves the ticket')
assert.equal(repo.getReport(id)!.status, 'needs_review')
assert.equal(repo.listComments(id).at(-1)!.evidence, 'verify.test.ts: 42 passed', 'the proof is stored on the comment')

// ── only the filer closes it ────────────────────────────────────────────────────────────────────────────────
const selfAccept = await call('set_status', { id, status: 'verified', agent: EXECUTOR })
assert.match(selfAccept, /^not_your_call/, 'the executor cannot mark its own work accepted')
assert.equal(repo.getReport(id)!.status, 'needs_review', 'and the ticket stays where it was')

const review = JSON.parse(await call('get_updates', { agent: FILER, filter: ['review'] })) as { count: number }
assert.ok(review.count >= 1, 'the filer is told its ticket is waiting for a verdict')

const noReason = await call('set_status', { id, status: 'rejected', agent: FILER })
assert.match(noReason, /^comment_required/, 'a rework order with no reason is refused even from the filer')
assert.match(await call('set_status', { id, status: 'rejected', agent: FILER, comment: 'Ссылка всё ещё без id.' }), /→ rejected/)

const rework = JSON.parse(await call('get_updates', { agent: EXECUTOR, filter: ['rework'] })) as { count: number }
assert.ok(rework.count >= 1, 'the rejection comes back to whoever held the ticket')
assert.match(await call('set_status', { id, status: 'verified', agent: FILER }), /→ verified/, 'the filer accepts')

// ── handover and back-compatibility ─────────────────────────────────────────────────────────────────────────
assert.match(await call('assign_task', { id, assignee: THIRD, agent: FILER }), /is now for "third-agent"/)
assert.equal(repo.getReport(id)!.assignee, THIRD)
assert.match(await call('assign_task', { id, assignee: '   ', agent: FILER }), /send null/, 'a blank assignee is not "unassign"')
assert.equal(repo.getReport(id)!.assignee, THIRD, 'and it did not detach the ticket')

// A client written before the lifecycle existed still works, under exactly the contract it was written against.
const legacyTask = await call('create_task', { assignee: EXECUTOR, title: 'legacy', body: 'проверка старого клиента', agent: FILER })
const legacyId = /id ([0-9a-f-]{36})$/.exec(legacyTask.trim())![1]!
assert.match(await call('set_status', { id: legacyId, status: 'triaged' }), /→ taken/, "'triaged' still maps to taken")
assert.match(
  await call('set_status', { id: legacyId, status: 'fixed', comment: 'готово', verifyUrl: LINK }),
  /→ needs_review/,
  "'fixed' from an agent still lands in needs_review on the old two-part contract",
)

// ── one surface, two servers ────────────────────────────────────────────────────────────────────────────────
const remote = await connect('remote.ts', { TH_COLLECTOR: 'http://127.0.0.1:9', TH_PROJECT_KEY: 'thr_unused_in_this_check' })
const names = (t: { tools: { name: string }[] }): string[] => t.tools.map((x) => x.name).sort()
const localNames = names(await local.listTools())
const remoteNames = names(await remote.listTools())
assert.deepEqual(localNames, remoteNames, `the two servers must offer the same tools\n local: ${localNames}\nremote: ${remoteNames}`)
console.log(`tools (both servers): ${localNames.join(', ')}`)

await local.close()
await remote.close()
// The repo keeps its connection open for the life of the process and Windows will not unlink an open file, so a
// failure here is housekeeping, not a failed check — but it says where the leftovers are instead of hiding them.
try {
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
} catch (e) {
  console.log(`temp database left at ${path.dirname(dbFile)} (${String(e)})`)
}
console.log('agents-e2e: done ✓')
process.exit(0)
