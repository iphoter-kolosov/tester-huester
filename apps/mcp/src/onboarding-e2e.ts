import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The onboarding text has THREE publishers — the local MCP server, the remote MCP server and GET /api/onboarding
// — and the entire point of the work is that they are one text. instructions-e2e proves the two MCP servers put
// something on the wire; this proves the third publisher agrees with them, character for character, and that the
// endpoint only answers someone holding a credential.
//
//   pnpm --filter @th/mcp onboarding-e2e
//
// Driven against a real `next start` on a throwaway database, because the route is the thing under test and a
// route imported directly never meets the router, the cookie jar or the built output. Nothing touches the live db.
const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '../../web')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-onboarding-'))
const dbFile = path.join(tmp, 'th.db')
const PORT = 4900 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`
const DASH_PASSWORD = 'onboarding-e2e'

process.env.SQLITE_FILE = dbFile
const { repo } = await import('@th/db')
const project = repo.createProject('onboarding-e2e')
// A second board exists so "this answer carries exactly one board's key" is a claim with something to fail against.
const otherProject = repo.createProject('another-board')
repo.upsertAgent({ handle: 'db-core', title: 'Ядро базы', role: 'Схема, миграции и репозиторий.', active: true, board: project.id })

const AGENT = 'onboarding-probe'
const EXPECTED_TOOLS = 16

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

function connect(entry: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, entry)],
    cwd: path.join(here, '..'),
    env: { ...(process.env as Record<string, string>), ...env },
  })
  const client = new Client({ name: 'onboarding-e2e', version: '0.0.0' })
  return client.connect(transport).then(() => client)
}

/** The identity paragraph is the ONE line that legitimately differs: over HTTP nobody is connected, so the route
 *  says "you have not said who you are" — which is the correct advice for an agent that is not configured yet. */
const withoutIdentity = (s: string): string =>
  s.split('\n').filter((l) => !/^(YOU ARE |YOU HAVE NO IDENTITY)/.test(l)).join('\n')

/** The board name and the roster listing are the two other lines the committed doc cannot carry — it renders with
 *  no board, and its roster is deliberately left unresolved so a snapshot of who was working never lands in git. */
function withoutBoardAndRoster(s: string): string[] {
  const out: string[] = []
  let inRoster = false
  for (const l of s.split('\n')) {
    if (l.startsWith('tester-huester — the shared board')) continue
    if (l.startsWith('ON THE BOARD')) {
      inRoster = true
      continue
    }
    if (inRoster) {
      if (l.startsWith('  • ')) continue
      inRoster = false
    }
    out.push(l)
  }
  return out
}

/** fetch() refuses to send a forged Host header, and Host is exactly the one a tunnel preserves while it may send
 *  no x-forwarded-host at all — so that case has to go out over a raw socket to prove anything. */
function rawGet(pathname: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
}

try {
  child = spawn(process.execPath, [path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], {
    cwd: webDir,
    env: { ...process.env, SQLITE_FILE: dbFile, UPLOAD_DIR: path.join(tmp, 'uploads'), DASH_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[next] ${d}`))
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${BASE}/api/agents?projectKey=${project.readKey}`)).status < 500) break
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`collector up on ${BASE} (real next start, throwaway db)\n`)

  // ── what a real MCP client is handed, printed so a reader can see the thing itself ──────────────────────────
  const local = await connect('index.ts', { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey, TH_AGENT: AGENT })
  const remote = await connect('remote.ts', { TH_COLLECTOR: BASE, TH_PROJECT_KEY: project.readKey, TH_AGENT: AGENT })
  const localText = local.getInstructions()
  const remoteText = remote.getInstructions()
  console.log('──── instructions as delivered to a client on initialize ────')
  console.log(localText ?? '<<< NOTHING WAS DELIVERED >>>')
  console.log(`──── end (${localText?.length ?? 0} chars) ────\n`)

  await check('1 the remote server against a LIVE collector reads the board and its roster', async () => {
    assert.ok(remoteText, 'no instructions on the client side')
    assert.match(remoteText, /onboarding-e2e/)
    assert.match(remoteText, /db-core/)
    assert.ok(!/could not be read/.test(remoteText), 'a reachable collector was reported as unreadable')
  })
  await check('2 local and remote hand out the SAME text for the same board and identity', async () => {
    assert.equal(remoteText, localText)
  })
  await check(`3 both servers still expose the same ${EXPECTED_TOOLS} tools`, async () => {
    const a = (await local.listTools()).tools.map((t) => t.name).sort()
    const b = (await remote.listTools()).tools.map((t) => t.name).sort()
    assert.deepEqual(a, b)
    assert.equal(a.length, EXPECTED_TOOLS, `tool count moved to ${a.length}: ${a.join(', ')}`)
  })

  // ── the collector as the third publisher ────────────────────────────────────────────────────────────────────
  const asAgent = await fetch(`${BASE}/api/onboarding?projectKey=${project.readKey}`)
  const agentBody = (await asAgent.json()) as Record<string, any>
  await check('4 an agent key gets 200 with the text and a connect line carrying its own key', async () => {
    assert.equal(asAgent.status, 200)
    assert.match(agentBody.connect.snippet, /claude mcp add tester-huester/)
    assert.match(agentBody.connect.snippet, new RegExp(project.readKey))
  })
  await check('5 the served text is byte-identical to the one the MCP client received', async () => {
    assert.equal(withoutIdentity(agentBody.instructions), withoutIdentity(localText!))
  })
  await check('6 and it invents no identity for a caller that has not connected', async () => {
    assert.match(agentBody.instructions, /YOU HAVE NO IDENTITY/)
    assert.ok(!/YOU ARE "/.test(agentBody.instructions))
  })
  await check('7 the INGEST key is not in the answer, and neither is another board\'s read key', async () => {
    const whole = JSON.stringify(agentBody)
    assert.ok(!whole.includes(project.ingestKey), 'the ingest key leaked — a read key must not fetch the write key')
    assert.ok(!whole.includes(otherProject.readKey))
  })
  await check('8 the ingest placeholder names the INGEST row of the dashboard, not the agent row', async () => {
    assert.match(agentBody.connect.snippet, /TH_INGEST_KEY=<ingest key th_… — dashboard, projects → ingest/)
  })

  await check('9 no credential is refused with 401, saying what to present', async () => {
    const r = await fetch(`${BASE}/api/onboarding`)
    assert.equal(r.status, 401)
    const b = (await r.json()) as Record<string, any>
    assert.equal(b.error, 'unauthorized')
    assert.match(b.message, /projectKey/)
  })
  await check('10 a wrong key is refused with 403', async () => {
    const r = await fetch(`${BASE}/api/onboarding?projectKey=thr_not_a_real_key`)
    assert.equal(r.status, 403)
    assert.equal(((await r.json()) as Record<string, any>).error, 'bad_project_key')
  })

  // The owner's cookie is minted here rather than through /login, which is a server action: signing it by the
  // documented scheme also proves the route verifies the signature instead of merely noticing a cookie.
  const payload = `v1.${Date.now()}`
  const cookie = `th_auth=${payload}.${crypto.createHmac('sha256', DASH_PASSWORD).update(payload).digest('hex')}`
  await check('11 the owner naming no board gets 400 and the list of boards, never a guessed key', async () => {
    const r = await fetch(`${BASE}/api/onboarding`, { headers: { cookie } })
    assert.equal(r.status, 400)
    const b = (await r.json()) as Record<string, any>
    assert.equal(b.error, 'project_required')
    assert.ok(b.projects.some((p: { name: string }) => p.name === 'onboarding-e2e'))
    assert.ok(!JSON.stringify(b).includes(project.readKey), 'a key was handed out for a board nobody named')
  })
  await check('12 the owner naming a board gets that board\'s snippet, still without the ingest key', async () => {
    const r = await fetch(`${BASE}/api/onboarding?project=${project.id}`, { headers: { cookie } })
    assert.equal(r.status, 200)
    const b = (await r.json()) as Record<string, any>
    assert.equal(withoutIdentity(b.instructions), withoutIdentity(localText!))
    assert.match(b.connect.snippet, new RegExp(project.readKey))
    assert.ok(!JSON.stringify(b).includes(project.ingestKey))
  })
  await check('13 ?format=text serves the same text plus the CONNECT block', async () => {
    const r = await fetch(`${BASE}/api/onboarding?projectKey=${project.readKey}&format=text`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /text\/plain/)
    const t = await r.text()
    assert.ok(t.startsWith(agentBody.instructions), 'the plain-text form opens with different instructions')
    assert.match(t, /claude mcp add tester-huester/)
  })

  // TH_COLLECTOR is the line an agent pastes; getting it from the wrong place points every new agent at the
  // collector's own loopback, and nothing fails until that agent's first call. This is where that is caught.
  const collectorLine = (snippet: string): string => snippet.split('\n').find((l) => l.includes('TH_COLLECTOR'))!.trim()
  await check('14 the snippet advertises the host the caller actually used, behind a proxy and without one', async () => {
    const proxied = await fetch(`${BASE}/api/onboarding?projectKey=${project.readKey}`, {
      headers: { 'x-forwarded-host': 'qa.example.test', 'x-forwarded-proto': 'https' },
    })
    const b = (await proxied.json()) as Record<string, any>
    assert.equal(collectorLine(b.connect.snippet), '-e TH_COLLECTOR=https://qa.example.test \\')

    const direct = JSON.parse(await rawGet(`/api/onboarding?projectKey=${project.readKey}`, { host: 'qa.example.test' }))
    assert.equal(collectorLine(direct.connect.snippet), '-e TH_COLLECTOR=http://qa.example.test \\')

    assert.ok(!collectorLine(agentBody.connect.snippet).includes('localhost'), 'a request to 127.0.0.1 was answered with localhost')
  })

  // ── the committed doc is only worth anything if it IS the served text ───────────────────────────────────────
  await check('15 docs/AGENT-WORKFLOW.md matches the served text line for line', async () => {
    const doc = fs.readFileSync(path.resolve(here, '../../..', 'docs', 'AGENT-WORKFLOW.md'), 'utf8')
    const fenced = doc.split('```text\n')[1]?.split('\n```')[0]
    assert.ok(fenced, 'no ```text block in docs/AGENT-WORKFLOW.md — it is supposed to be a rendering')
    assert.deepEqual(withoutBoardAndRoster(fenced), withoutBoardAndRoster(agentBody.instructions))
  })

  await local.close()
  await remote.close()
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 300))
}

for (const r of results) console.log(r)
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\n=== every onboarding check passed ===')
process.exit(failed ? 1 : 0)
