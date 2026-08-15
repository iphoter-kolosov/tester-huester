import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The remote server driven the way an agent drives it — over stdio, against the REAL collector route handlers,
// over REAL HTTP, on a throwaway database. agents-e2e proves the local server; this proves the other half, which
// nothing else touches: the roster tools over HTTPS, the signed comment, and whether a refusal still carries the
// roster by the time the agent reads it. (It did not, at first: create_task wrapped the collector's answer and
// clipped it at 300 characters, mid-roster. That is what this file caught.)
//
//   pnpm --filter @th/mcp remote-e2e
//
// Next is deliberately NOT started. A dev server shares apps/web/.next with whoever else is building, and dies on
// it; the route MODULES are imported and dispatched by the small server below instead, so what is under test is
// the same code the deployed collector runs, minus the router. The `--tsconfig` flag in the script is what lets
// those modules resolve their own `@/` imports.
const here = path.dirname(fileURLToPath(import.meta.url))
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-remote-')), 'th.db')
process.env.SQLITE_FILE = dbFile

const { repo } = await import('@th/db')
const agentsRoute = await import('../../web/app/api/agents/route.ts')
const reportsRoute = await import('../../web/app/api/reports/route.ts')
const reportRoute = await import('../../web/app/api/reports/[id]/route.ts')
const commentsRoute = await import('../../web/app/api/reports/[id]/comments/route.ts')
const ingestRoute = await import('../../web/app/api/ingest/route.ts')

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
const NO_ID = { params: Promise.resolve({ id: '' }) }

function route(method: string, pathname: string): { handler: Handler; ctx: { params: Promise<{ id: string }> } } | null {
  const pick = (mod: Record<string, unknown>): Handler | null => (typeof mod[method] === 'function' ? (mod[method] as Handler) : null)
  const withId = (id: string) => ({ params: Promise.resolve({ id }) })
  if (pathname === '/api/agents') return pick(agentsRoute) ? { handler: pick(agentsRoute)!, ctx: NO_ID } : null
  if (pathname === '/api/reports') return pick(reportsRoute) ? { handler: pick(reportsRoute)!, ctx: NO_ID } : null
  if (pathname === '/api/ingest') return pick(ingestRoute) ? { handler: pick(ingestRoute)!, ctx: NO_ID } : null
  const comments = /^\/api\/reports\/([^/]+)\/comments$/.exec(pathname)
  if (comments) return pick(commentsRoute) ? { handler: pick(commentsRoute)!, ctx: withId(decodeURIComponent(comments[1]!)) } : null
  const one = /^\/api\/reports\/([^/]+)$/.exec(pathname)
  if (one) return pick(reportRoute) ? { handler: pick(reportRoute)!, ctx: withId(decodeURIComponent(one[1]!)) } : null
  return null
}

const PORT = 4400 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', BASE)
    const match = route(req.method ?? 'GET', url.pathname)
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no_route', path: url.pathname }))
      return
    }
    const body = Buffer.concat(chunks)
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: body.length ? body : undefined,
    })
    try {
      const answer = await match.handler(request, match.ctx)
      const text = await answer.text()
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' })
      res.end(text)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'handler_threw', message: String(e) }))
    }
  })
})
await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const project = repo.createProject('probe-board')
const ME = 'probe-agent'
const MATE = 'probe-mate'
console.log(`collector up on ${BASE} (real route handlers, throwaway db)`)

function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, 'remote.ts')],
    cwd: path.join(here, '..'),
    env: { ...(process.env as Record<string, string>), ...env },
  })
  const client = new Client({ name: 'remote-probe', version: '0.0.0' })
  return client.connect(transport).then(() => client)
}

const named = await connect({ TH_COLLECTOR: BASE, TH_PROJECT_KEY: project.readKey, TH_INGEST_KEY: project.ingestKey, TH_AGENT: ME })
const anon = await connect({ TH_COLLECTOR: BASE, TH_PROJECT_KEY: project.readKey, TH_INGEST_KEY: project.ingestKey, TH_AGENT: '' })

const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> =>
  ((await c.callTool({ name, arguments: args })).content as Array<{ type: string; text: string }>)[0]!.text

// 1 — whoami, answered from the live collector
const who = JSON.parse(await call(named, 'whoami')) as {
  identity: string; source: string; registered: boolean; board: { name: string } | null; warnings: string[]
}
assert.equal(who.identity, ME)
assert.equal(who.source, 'env')
assert.equal(who.board?.name, 'probe-board')
assert.equal(who.registered, false, 'declared but not yet on the roster')
console.log('1 whoami (remote): identity, its source and the board read off the live collector ✓')

const anonWho = JSON.parse(await call(anon, 'whoami')) as { identity: string; source: string; warnings: string[] }
assert.equal(anonWho.source, 'fallback')
assert.equal(anonWho.identity, 'probe-board')
assert.ok(anonWho.warnings.some((w) => w.includes('TH_AGENT')))
console.log('2 whoami with no TH_AGENT: the board name is reported AS a fallback, with the warning ✓')

// 3 — registering yourself, and the refusal to register a board
const reg = JSON.parse(await call(named, 'register_agent', { title: 'Проба', role: 'Проверяет удалённый сервер.' })) as {
  agent: { handle: string; role: string; boards: string[] }
}
assert.equal(reg.agent.handle, ME)
assert.equal(reg.agent.role, 'Проверяет удалённый сервер.')
assert.deepEqual(reg.agent.boards, [project.id])
assert.equal(repo.getAgent(ME)?.role, 'Проверяет удалённый сервер.', 'stored in the database, not merely echoed')
console.log('3 register_agent (remote): the entry is written through the API ✓')

assert.match(await call(anon, 'register_agent', { role: 'x' }), /TH_AGENT/)
assert.equal(repo.getAgent('probe-board'), null, 'and the board did NOT become an agent')
assert.match(await call(named, 'register_agent', {}), /at least one of/)
console.log('4 a server with no identity cannot register; the board stayed off the roster ✓')

// 5 — the roster, in the shape the local server also answers in
const roster = JSON.parse(await call(named, 'list_agents', { activeOnly: true })) as { count: number; agents: { handle: string }[] }
assert.ok(roster.agents.some((a) => a.handle === ME))
assert.ok(!roster.agents.some((a) => a.handle === 'extension'), 'the retired capture channel is not offered')
assert.equal(roster.count, roster.agents.length)
console.log(`5 list_agents (remote): ${roster.count} addressable, same {count, agents} shape as the local server ✓`)

// 6 — the refusal must arrive WITH the roster: this is exactly what the old 300-character clip destroyed
const typo = await call(named, 'create_task', { assignee: 'probe-agnet', title: 'x', body: 'y' })
assert.match(typo, /^unknown_assignee/, `expected a named refusal, got: ${typo}`)
assert.match(typo, /probe-agent \(Проба\) — Проверяет удалённый сервер\./, 'the roster survived the trip, roles intact')
assert.ok(typo.length > 300, `the refusal was clipped to ${typo.length} characters`)
assert.equal(repo.listReports({ projectId: project.id }).length, 0, 'and nothing was filed')
console.log(`6 create_task refusal reaches the agent whole (${typo.length} chars, roster and roles intact) ✓`)

// 7 — a real address goes through
repo.upsertAgent({ handle: MATE, title: 'Коллега', role: 'Принимает работу.', board: project.id })
const filed = await call(named, 'create_task', { assignee: MATE, title: 'Проверка', body: 'Тело задачи.', links: [`${BASE}/qa`] })
const id = /id ([0-9a-f-]{36})$/.exec(filed.trim())?.[1]
assert.ok(id, `create_task returned an id: ${filed}`)
assert.equal(repo.getReport(id)!.creator, ME)
assert.equal(repo.getReport(id)!.assignee, MATE)
console.log('7 create_task to a real addressee is filed, with the filer recorded ✓')

// 8 — the comment is signed by the AGENT, not by the board: the complaint this stage exists for
await call(named, 'add_comment', { id, body: 'Подписанный комментарий.' })
assert.equal(repo.listComments(id!).at(-1)!.author, ME, 'the comment is authored by the agent')
await call(anon, 'add_comment', { id, body: 'Неподписанный комментарий.' })
assert.equal(repo.listComments(id!).at(-1)!.author, 'probe-board', 'an unsigned one is still the board')
assert.equal(repo.getAgent('probe-board'), null, 'and it registered nobody')
console.log('8 add_comment signs the thread with the identity; unsigned stays the board and registers nobody ✓')

// 9 — handing work to a stranger, refused in the same words the local server uses
const handover = await call(named, 'assign_task', { id, assignee: 'nobody-here' })
assert.match(handover, /^unknown_assignee/)
assert.match(handover, /probe-mate/, 'and it names who could actually take it')
assert.equal(repo.getReport(id!)!.assignee, MATE, 'the ticket was not detached')

const blank = await call(named, 'assign_task', { id, assignee: '   ' })
assert.match(blank, /^bad_assignee/)
assert.match(blank, /Send null/)
assert.equal(repo.getReport(id!)!.assignee, MATE)
console.log('9 assign_task refusals (stranger, blank) arrive named and the ticket is untouched ✓')

console.log('=== every remote check passed ===')
await named.close()
await anon.close()
server.close()
process.exit(0)
