import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The session fingerprint, driven exactly as an agent hits it — two SEPARATE processes over stdio, both signing as
// the same handle, against one throwaway database. Proves the thing that cannot be read off the types: that the
// SECOND fork's whoami shouts a collision naming the first, that a lone process does not, and that every write is
// stamped with the session that made it.
//
//   pnpm --filter @th/mcp exec tsx src/session-e2e.ts
//
// SQLITE_FILE is pointed at a temp file BEFORE @th/db is imported (dynamic import — a static one would hoist above
// the assignment and open the real database).
const here = path.dirname(fileURLToPath(import.meta.url))
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-session-')), 'th.db')
process.env.SQLITE_FILE = dbFile

const { repo } = await import('@th/db')
const project = repo.createProject('session-e2e')

const HANDLE = 'erental'
const LINK = 'https://example.test/screen?id=9'

function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, 'index.ts')],
    cwd: path.join(here, '..'),
    env: { ...(process.env as Record<string, string>), ...env },
  })
  const client = new Client({ name: 'session-e2e', version: '0.0.0' })
  return client.connect(transport).then(() => client)
}

type WhoAmIAnswer = {
  identity: string
  session: { sessionId: string; shortId: string; origin: string; startedAt: number } | null
  warnings: string[]
}
const whoamiOf = async (c: Client, args: Record<string, unknown> = {}): Promise<WhoAmIAnswer> =>
  JSON.parse(((await c.callTool({ name: 'whoami', arguments: args })).content as Array<{ text: string }>)[0]!.text) as WhoAmIAnswer

const base = { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey, TH_AGENT: HANDLE }

// ── a lone process is not warned, but it DOES know its own session ──────────────────────────────────────────
const first = await connect({ ...base, TH_SESSION_LABEL: 'checkout-worktree' })
const aloneFirst = await whoamiOf(first)
assert.ok(aloneFirst.session, 'whoami carries a session block')
assert.equal(aloneFirst.session!.origin, 'checkout-worktree', 'TH_SESSION_LABEL becomes the session origin')
assert.equal(aloneFirst.session!.shortId.length, 8, 'the short session id is the first 8 chars of the uuid')
assert.ok(
  !aloneFirst.warnings.some((w) => w.startsWith('COLLISION')),
  'a single process signing as the handle is NOT warned — no false alarm',
)

// ── a SECOND process signing as the same handle: the collision fires and names the first ────────────────────
const second = await connect({ ...base, TH_SESSION_LABEL: 'admin-worktree' })
const collided = await whoamiOf(second)
const collision = collided.warnings.find((w) => w.startsWith('COLLISION'))
assert.ok(collision, `the second fork's whoami must shout a collision — warnings: ${JSON.stringify(collided.warnings)}`)
assert.ok(collision!.includes('2 live sessions'), 'it counts both live sessions')
assert.ok(collision!.includes(`signing as "${HANDLE}"`), 'and names the handle they are fighting over')
assert.ok(collision!.includes('checkout-worktree'), 'it names the OTHER live session by its origin, so the fix is concrete')
assert.ok(collision!.includes(aloneFirst.session!.shortId), 'and by its short session id')
assert.ok(collision!.includes('TH_AGENT') && collision!.includes('TH_SESSION_LABEL'), 'and says exactly what to set to fix it')
// The warning is at the FRONT of the list — an agent scanning warnings meets the collision first.
assert.ok(collided.warnings[0]!.startsWith('COLLISION'), 'the collision leads the warnings, not buried under role nags')

// ── the first process now sees the collision too: it is symmetric, not a property of "who started later" ─────
const firstAgain = await whoamiOf(first)
assert.ok(
  firstAgain.warnings.some((w) => w.startsWith('COLLISION') && w.includes('admin-worktree')),
  'the first process, asking again, is now warned about the second — the check is on live sessions, not birth order',
)

// ── the two sessions are genuinely distinct ids ─────────────────────────────────────────────────────────────
assert.notEqual(aloneFirst.session!.sessionId, collided.session!.sessionId, 'each process minted its own session id')

// ── every write is stamped with the session that made it ────────────────────────────────────────────────────
// Register a role so this handle may file, then file a task from the SECOND process and read the journal back.
await second.callTool({ name: 'register_agent', arguments: { title: 'eRENTAL', role: 'Витрина проката; чинит каталог и корзину.' } })
const filed = ((await second.callTool({
  name: 'create_task',
  arguments: { assignee: HANDLE, title: 'Сессия пишется в журнал', body: 'Проверка происхождения записи.', links: [LINK] },
}).then((r) => r)).content as Array<{ text: string }>)[0]!.text
const reportId = /id ([0-9a-f-]{36})$/.exec(filed.trim())?.[1]
assert.ok(reportId, `create_task returned an id: ${filed}`)

const events = repo.eventsSince(project.id, 0, 100)
const created = events.find((e) => e.reportId === reportId && e.kind === 'created')
assert.ok(created, 'the create landed in the journal')
assert.equal(created!.session, collided.session!.sessionId, 'and the journal entry is stamped with the SECOND process\'s session — write-origin is recorded')

await first.close()
await second.close()
try {
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
} catch (e) {
  console.log(`temp database left at ${path.dirname(dbFile)} (${String(e)})`)
}
console.log('session-e2e: done ✓ — a second fork of one handle is caught and named, and every write records its session')
process.exit(0)
