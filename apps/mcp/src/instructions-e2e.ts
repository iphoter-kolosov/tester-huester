import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Proof that the onboarding text REACHES a client — not that the field compiles.
//
//   pnpm --filter @th/mcp instructions-e2e
//
// The SDK's own client is connected to our own server over stdio, the initialize handshake runs for real, and what
// is asserted is `client.getInstructions()`: the value the protocol delivered, on the other side of the pipe. A
// server can hold a perfectly good string and never put it on the wire; only the far end can say otherwise.
//
// Both servers are checked, because they are two McpServer instances and a wiring mistake in one is invisible from
// the other. The remote one is pointed at a dead port on purpose — the interesting case is a collector that cannot
// be reached at boot, where the server must still come up and must say why the board looks empty.
const here = path.dirname(fileURLToPath(import.meta.url))
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-instr-')), 'th.db')
process.env.SQLITE_FILE = dbFile

const { repo } = await import('@th/db')
const { ONBOARDING_TOOLS } = await import('@th/db')
const project = repo.createProject('instructions-e2e')

const COLLEAGUE = 'mcp-core'
const COLLEAGUE_ROLE = 'Owns the MCP servers and their contract; does not touch the dashboard.'
repo.upsertAgent({ handle: COLLEAGUE, title: 'MCP-ядро', role: COLLEAGUE_ROLE, active: true, board: project.id })

/** A port nothing listens on: the boot lookup fails fast and locally, with no network involved. */
const DEAD_COLLECTOR = 'http://127.0.0.1:9'

function connect(entry: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, entry)],
    cwd: path.join(here, '..'),
    env: { ...(process.env as Record<string, string>), ...env },
  })
  const client = new Client({ name: 'instructions-e2e', version: '0.0.0' })
  return client.connect(transport).then(() => client)
}

// ── the local server: a named agent on a named board, with its colleagues in the greeting ───────────────────
const local = await connect('index.ts', { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey, TH_AGENT: 'stage-agent' })
const localText = local.getInstructions()
assert.ok(localText, 'the local server sent NO instructions — the client received undefined after initialize')
assert.match(localText, /instructions-e2e/, 'the greeting names the board this server is pinned to')
assert.match(localText, /YOU ARE "stage-agent"/, 'and the identity TH_AGENT gave it')
assert.ok(localText.includes(COLLEAGUE_ROLE), 'and it introduces the colleague already on the roster, by role')
assert.match(localText, /new → taken → needs_review → verified \| rejected/, 'the lifecycle is spelled out')
assert.match(localText, /evidence \(PROOF\)/, 'and the part of the work report agents skip most')

// Every tool the greeting tells the agent to call must actually be on this server. This is the link that keeps
// ONBOARDING_TOOLS from quietly becoming a second, hand-written copy of the tool list.
const offered = new Set((await local.listTools()).tools.map((t) => t.name))
for (const tool of Object.values(ONBOARDING_TOOLS)) {
  assert.ok(offered.has(tool), `the instructions tell the agent to call "${tool}", which this server does not offer`)
  assert.ok(localText.includes(tool), `"${tool}" is in ONBOARDING_TOOLS but never appears in the text`)
}

// ── an unnamed server says so in the greeting, not only in whoami ────────────────────────────────────────────
const anonymous = await connect('index.ts', { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey, TH_AGENT: '' })
const anonText = anonymous.getInstructions()!
assert.match(anonText, /YOU HAVE NO IDENTITY/, 'a server with no TH_AGENT tells every client so on connect')
assert.match(anonText, /signed with "instructions-e2e"/, 'and names the BOARD it is signing as instead')
await anonymous.close()

// ── the remote server: a dead collector must not stop it starting, and must not look like an empty board ────
const remote = await connect('remote.ts', { TH_COLLECTOR: DEAD_COLLECTOR, TH_PROJECT_KEY: 'thr_unused_in_this_check', TH_AGENT: 'remote-agent' })
const remoteText = remote.getInstructions()
assert.ok(remoteText, 'the remote server sent NO instructions')
assert.match(remoteText, /the roster could not be read/, 'an unreachable collector is reported, not shown as an empty board')
assert.ok(!/nobody yet/.test(remoteText), 'and it is never phrased as "you are the first agent here"')
assert.match(remoteText, /YOU ARE "remote-agent"/, 'the identity it does know is still stated')
const remoteOffered = new Set((await remote.listTools()).tools.map((t) => t.name))
for (const tool of Object.values(ONBOARDING_TOOLS)) {
  assert.ok(remoteOffered.has(tool), `the remote server does not offer "${tool}", which its instructions name`)
}

// ── a collector that HANGS, which is the case that would take the owner's agents offline ────────────────────
// A dead port refuses instantly and never exercises the startup deadline at all. This one accepts the connection
// and then answers nothing — the black hole a lookup without a timeout waits on forever, leaving every agent
// pointed at this server with no tools.
const blackHole = http.createServer(() => {
  /* accept, hold, never respond */
})
await new Promise<void>((r) => blackHole.listen(0, '127.0.0.1', r))
const hangingPort = (blackHole.address() as { port: number }).port
const startedAt = Date.now()
const hung = await connect('remote.ts', {
  TH_COLLECTOR: `http://127.0.0.1:${hangingPort}`,
  TH_PROJECT_KEY: 'thr_unused_in_this_check',
  TH_AGENT: 'hung-agent',
})
const bootMs = Date.now() - startedAt
const hungText = hung.getInstructions()
assert.ok(hungText, 'a hanging collector stopped the server delivering instructions at all')
assert.match(hungText, /the roster could not be read/, 'a hanging collector is reported, not shown as an empty board')
assert.ok(!/nobody yet/.test(hungText), 'and never as "you are the first agent here"')
assert.equal((await hung.listTools()).tools.length, (await local.listTools()).tools.length, 'it came up with a different tool list')
// The claim being defended is "bounded", not a stopwatch reading: the lookup budget plus a cold tsx start, with
// enough headroom that a loaded CI box does not fail this for being slow.
assert.ok(bootMs < 20_000, `startup took ${bootMs} ms — a slow collector must never hold an agent offline`)
await hung.close()
blackHole.close()

console.log(`local instructions: ${localText.length} chars, remote: ${remoteText.length} chars`)
console.log(`hanging collector: server ready in ${bootMs} ms, with its tools and a stated reason`)
await local.close()
await remote.close()
// The repo holds its connection open for the life of the process and Windows will not unlink an open file, so a
// failure here is housekeeping — reported rather than hidden, so the leftovers are findable.
try {
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
} catch (e) {
  console.log(`temp database left at ${path.dirname(dbFile)} (${String(e)})`)
}
console.log('instructions-e2e: done ✓')
process.exit(0)
