import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { repo } from '@th/db'

// The MCP surface: an AI agent (Claude Code, the client's agents) pulls captured reports, reads a report's
// screenshot URL + note, and triages status — the loop's payoff. Reads the same SQLite the web/extension use.
const STATUS = z.enum(['new', 'triaged', 'fixed', 'wontfix'])
const server = new McpServer({ name: 'tester-huester', version: '0.1.0' })

server.tool(
  'list_reports',
  'List captured QA reports, newest first. Optionally filter by status.',
  { status: STATUS.optional(), limit: z.number().int().min(1).max(500).optional() },
  async ({ status, limit }) => ({
    content: [{ type: 'text', text: JSON.stringify(repo.listReports({ status, limit }), null, 2) }],
  }),
)

server.tool(
  'get_report',
  'Get one report by id (note, screenshot URL, page URL, status, metadata).',
  { id: z.string() },
  async ({ id }) => {
    const r = repo.getReport(id)
    return { content: [{ type: 'text', text: r ? JSON.stringify(r, null, 2) : `no report ${id}` }] }
  },
)

server.tool(
  'set_status',
  'Set a report\'s triage status (new | triaged | fixed | wontfix).',
  { id: z.string(), status: STATUS },
  async ({ id, status }) => {
    const ok = repo.setStatus(id, status)
    return { content: [{ type: 'text', text: ok ? `report ${id} → ${status}` : `no report ${id}` }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('tester-huester MCP server ready (stdio)')
