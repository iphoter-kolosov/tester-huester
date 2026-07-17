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

const list = await client.callTool({ name: 'list_reports', arguments: { limit: 5 } })
const text = (list.content as Array<{ type: string; text: string }>)[0]!.text
const rows = JSON.parse(text) as Array<{ id: string; note: string }>
console.log(`list_reports: ${rows.length} report(s)`)
if (rows[0]) {
  console.log('first note:', JSON.stringify(rows[0].note))
  const one = await client.callTool({ name: 'get_report', arguments: { id: rows[0].id } })
  const got = (one.content as Array<{ type: string; text: string }>)[0]!.text
  console.log('get_report ok:', got.includes(rows[0].id))
}

await client.close()
process.exit(0)
