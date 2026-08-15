import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Spins up the MCP server as a child over stdio and drives it like an agent would: list tools, list
// reports, read one. Proves the MCP surface end-to-end against the real DB.
const here = path.dirname(fileURLToPath(import.meta.url))

const transport = new StdioClientTransport({
  command: process.execPath, // the node binary — cross-platform
  args: ['--import', 'tsx', path.join(here, 'index.ts')],
})
const client = new Client({ name: 'smoke', version: '0.0.0' })
await client.connect(transport)

const tools = await client.listTools()
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '))

// The identity half of the surface, read-only on purpose: this runs against the REAL database, and registering a
// smoke-test agent would leave a fake colleague on the roster for everyone else to address work to.
const me = await client.callTool({ name: 'whoami', arguments: {} })
const who = JSON.parse((me.content as Array<{ type: string; text: string }>)[0]!.text) as {
  identity: string
  source: string
  registered: boolean
  warnings: string[]
}
console.log(`whoami: "${who.identity}" (source: ${who.source}, on the roster: ${who.registered})`)
for (const w of who.warnings) console.log('  ! ' + w)

const rosterText = (
  (await client.callTool({ name: 'list_agents', arguments: {} })).content as Array<{ type: string; text: string }>
)[0]!.text
const roster = JSON.parse(rosterText) as { count: number; agents: Array<{ handle: string; role: string }> }
console.log(`list_agents: ${roster.count} on the roster`)
for (const a of roster.agents) console.log(`  • ${a.handle} — ${a.role || '(no role yet)'}`)

const list = await client.callTool({ name: 'list_reports', arguments: { limit: 20 } })
const text = (list.content as Array<{ type: string; text: string }>)[0]!.text
const rows = JSON.parse(text) as Array<{ id: string; note: string; context: unknown }>
console.log(`list_reports: ${rows.length} report(s)`)
if (rows[0]) {
  console.log('first note:', JSON.stringify(rows[0].note))
  const one = await client.callTool({ name: 'get_report', arguments: { id: rows[0].id } })
  const got = (one.content as Array<{ type: string; text: string }>)[0]!.text
  console.log('get_report ok:', got.includes(rows[0].id))
}

// Exercise the new agent-facing tool on a report that has a repro bundle.
const withCtx = rows.find((r) => r.context)
if (withCtx) {
  const steps = await client.callTool({ name: 'get_repro_steps', arguments: { id: withCtx.id } })
  const out = (steps.content as Array<{ type: string; text: string }>)[0]!.text
  const parsed = JSON.parse(out) as { steps: string[]; consoleErrors: string[]; failedRequests: string[] }
  console.log(`get_repro_steps: ${parsed.steps.length} step(s), ${parsed.consoleErrors.length} console error(s), ${parsed.failedRequests.length} failed request(s)`)
  console.log('  step 1:', parsed.steps[0])
  console.log('  failed:', parsed.failedRequests[0] ?? '(none)')
} else {
  console.log('get_repro_steps: (no report with context found — capture one first)')
}

await client.close()
process.exit(0)
