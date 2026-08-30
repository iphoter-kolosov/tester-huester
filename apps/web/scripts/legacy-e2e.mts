import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Does the board still answer the clients that were written before it had a roster?
//
// This is the question the roster work is most able to break and least able to notice. The owner has agents in
// production right now that send no `agent`, no `assignee` and the pre-lifecycle status words — an erental agent
// posting `fixed` with a comment and a link, and the browser extension posting captures to /api/ingest. A refusal
// there does not look like a bug on the dashboard; it looks like the agents went quiet.
//
//   pnpm --filter web legacy-e2e
//
// Driven over real HTTP against a real `next start` on a throwaway database — not the route modules imported
// directly, because a legacy client meets the router, the body parser and the built output too. Nothing here
// touches the live database.
const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-legacy-'))
const dbFile = path.join(tmp, 'th.db')
const PORT = 4700 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`

// Seeded before the server opens the file: the schema, the projects and the roster rows a legacy client will be
// judged against all have to exist by the time the first request lands.
process.env.SQLITE_FILE = dbFile
const { repo } = await import('@th/db')
const project = repo.createProject('erental')
const other = repo.createProject('photoking agents')
repo.upsertAgent({ handle: 'db-core', title: 'Ядро базы', role: 'Схема, миграции и репозиторий.' })

let child: ChildProcess | null = null
let failed = 0
const results: string[] = []

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push(`✓ ${name}`)
  } catch (e) {
    failed++
    results.push(`✗ ${name}\n    ${String((e as Error).message ?? e).split('\n').join('\n    ')}`)
  }
}

type Answer = { status: number; body: Record<string, any> }
const j = async (res: Response): Promise<Answer> => ({ status: res.status, body: (await res.json()) as Record<string, any> })
const post = (p: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = (p: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

try {
  child = spawn(process.execPath, [path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], {
    cwd: webDir,
    // No DASH_PASSWORD on purpose: the owner-side paths are not what this file is about, and an open dashboard
    // keeps the probe to the agent contract.
    env: { ...process.env, SQLITE_FILE: dbFile, UPLOAD_DIR: path.join(tmp, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[next] ${d}`))

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/agents?projectKey=${project.readKey}`)
      if (r.status < 500) break
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`collector up on ${BASE} (real next start, throwaway db)`)

  // ── the extension, unchanged ────────────────────────────────────────────────────────────────────────────
  let extensionTicket = ''
  await check('1 extension capture (no creator, no assignee, no agent) is filed FOR the owner, channel kept as via', async () => {
    const { status, body } = await j(
      await post('/api/ingest', {
        ingestKey: project.ingestKey,
        note: 'кнопка не нажимается',
        pageUrl: 'https://erental.hu/checkout',
        viewport: '1280x800',
        reporter: 'Ihor',
      }),
    )
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    // A capture with no declared filer is the owner's — he is the one holding the extension — so he is recorded as
    // the creator and can later verify his own ticket (only the filer or the owner may). The extension channel is
    // not lost: it lands in `via`. This replaces the old fallback that filed as "extension", an identity nobody
    // could act as, which is why owner captures used to sit unclosable.
    assert.equal(body.creator, 'owner', 'an anonymous capture is filed FOR the owner, not the extension')
    assert.equal(body.assignee, null)
    extensionTicket = body.id
    assert.equal(repo.getReport(body.id)?.via, 'extension', 'the channel the capture arrived through is preserved')
    // The capture channel must not have been promoted to a working agent by the act of capturing.
    assert.equal(repo.getAgent('extension')?.active, false, 'extension must stay unaddressable')
  })

  await check('2 the board name is NOT registered by a client that declared no identity', async () => {
    const roster = repo.listAgents().map((a) => a.handle)
    assert.ok(!roster.includes('erental'), `board name leaked onto the roster: ${roster.join(', ')}`)
    assert.ok(!roster.includes('photoking agents'), `board name leaked onto the roster: ${roster.join(', ')}`)
  })

  // ── an agent written before identities existed ──────────────────────────────────────────────────────────
  await check('3 legacy set_status "triaged" with no agent still works', async () => {
    const { status, body } = await j(await patch(`/api/reports/${extensionTicket}?projectKey=${project.readKey}`, { status: 'triaged' }))
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.status, 'taken')
    assert.equal(body.agent, 'erental', 'an unsigned write is still attributed to the board')
  })

  await check('4 legacy set_status "fixed" keeps the OLD two-part contract (comment + link, no steps, no evidence)', async () => {
    const { status, body } = await j(
      await patch(`/api/reports/${extensionTicket}?projectKey=${project.readKey}`, {
        status: 'fixed',
        comment: 'починил обработчик клика',
        verifyUrl: 'https://erental.hu/checkout',
      }),
    )
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.status, 'needs_review', 'a claim from an executor waits for the filer')
    assert.ok(body.comment, 'the work report is posted as a comment')
    assert.ok(!repo.listAgents().map((a) => a.handle).includes('erental'), 'an unsigned status change must register nobody')
  })

  await check('5 legacy add_comment with no agent posts under the board name and registers nobody', async () => {
    const { status, body } = await j(
      await post(`/api/reports/${extensionTicket}/comments?projectKey=${project.readKey}`, { body: 'не воспроизвёл на стенде' }),
    )
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.comment.author, 'erental')
    assert.equal(body.agent, 'erental')
    assert.ok(!repo.listAgents().map((a) => a.handle).includes('erental'))
  })

  await check('6 legacy list_reports still lists, and separates the agents from the board name holding a ticket', async () => {
    const { status, body } = await j(await fetch(`${BASE}/api/reports?projectKey=${project.readKey}`))
    assert.equal(status, 200, JSON.stringify(body))
    assert.ok(body.count >= 1)
    assert.ok(Array.isArray(body.agents), 'the roster block rides along')
    // The capture's creator is now the OWNER (a real, addressable roster row), so the owner is the participant the
    // block carries. The channel, 'extension', rides in the ticket's `via` field, not as a participating agent.
    assert.ok(body.agents.some((a: { handle: string }) => a.handle === 'owner'))
    // The unsigned status change above stamped taken_by with the board's name — that is the attribution rule
    // working as designed. What must never happen is that name arriving as an AGENT: it is reported apart, which
    // is what lets the dashboard mark it "НЕ В СОСТАВЕ" instead of drawing it as a colleague.
    assert.deepEqual(body.unknownParticipants, ['erental'])
    assert.ok(!body.agents.some((a: { handle: string }) => a.handle === 'erental'))
  })

  await check('7 legacy ?status=fixed filter still returns the claimed-done tickets', async () => {
    const { body } = await j(await fetch(`${BASE}/api/reports?projectKey=${project.readKey}&status=fixed`))
    assert.equal(body.count, 1, 'the ticket now sitting in needs_review must still answer the old word')
  })

  await check('8 legacy get_updates + ack with no identity moves the PROJECT cursor, as it always did', async () => {
    const first = await j(await fetch(`${BASE}/api/updates?projectKey=${project.readKey}`))
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.ok(first.body.count > 0, 'the legacy writes above are in the journal')
    assert.equal(first.body.agent, null)
    const ack = await j(await post(`/api/updates?projectKey=${project.readKey}`, { cursor: first.body.cursor }))
    assert.equal(ack.body.ok, true)
    const second = await j(await fetch(`${BASE}/api/updates?projectKey=${project.readKey}`))
    assert.equal(second.body.count, 0, 'an unnamed ack must still advance the position the unnamed read uses')
  })

  await check('9 the owner keeps ONE name in the journal — no event is attributed to "human"', async () => {
    const { body } = await j(await fetch(`${BASE}/api/updates?projectKey=${project.readKey}&since=0&limit=200`))
    assert.ok(!body.events.some((e: { actor: string }) => e.actor === 'human'), 'the legacy owner spelling must not come back')
  })

  // ── the roster as a working address book ────────────────────────────────────────────────────────────────
  await check('10 a declared agent joins the roster by acting, and is then addressable', async () => {
    const filed = await j(
      await post('/api/ingest', { ingestKey: project.ingestKey, note: 'описать роль в ростере', creator: 'mcp-core', assignee: 'mcp-core' }),
    )
    assert.equal(filed.status, 200, JSON.stringify(filed.body))
    assert.equal(filed.body.creator, 'mcp-core')
    assert.equal(filed.body.assignee, 'mcp-core', 'an agent may address its very first ticket to itself')
    assert.ok(repo.getAgent('mcp-core'), 'acting under a declared name registers it')
  })

  await check('11 an unknown addressee is refused, and the refusal carries the roster with the roles', async () => {
    const { status, body } = await j(
      await post('/api/ingest', { ingestKey: project.ingestKey, note: 'x', creator: 'mcp-core', assignee: 'mcp-corp' }),
    )
    assert.equal(status, 400)
    assert.equal(body.error, 'unknown_assignee')
    assert.match(body.message, /db-core/, 'the real agents are listed')
    assert.match(body.message, /Схема, миграции/, 'with what each of them does')
    assert.ok(!/• extension/.test(body.message), 'a retired entry must not be offered as an option')
  })

  await check('12 a write updates last_seen; the owner describing an agent does NOT', async () => {
    const before = repo.getAgent('mcp-core')!.lastSeen
    await new Promise((r) => setTimeout(r, 5))
    await post(`/api/reports/${extensionTicket}/comments?projectKey=${project.readKey}`, { body: 'ещё раз', agent: 'mcp-core' })
    const afterWrite = repo.getAgent('mcp-core')!.lastSeen
    assert.ok(afterWrite > before, 'acting is a liveness signal')
    repo.upsertAgent({ handle: 'mcp-core', role: 'написано владельцем' })
    assert.equal(repo.getAgent('mcp-core')!.lastSeen, afterWrite, 'being described is not acting')
  })

  await check('13 a project read key cannot reach another board (the roster did not widen scope)', async () => {
    const { status } = await j(await fetch(`${BASE}/api/reports/${extensionTicket}?projectKey=${other.readKey}`))
    assert.equal(status, 404)
  })
} finally {
  child?.kill()
}

console.log('')
for (const line of results) console.log(line)
console.log('')
if (failed) {
  console.error(`=== ${failed} legacy check(s) FAILED ===`)
  process.exit(1)
}
console.log('=== every legacy check passed ===')
process.exit(0)
