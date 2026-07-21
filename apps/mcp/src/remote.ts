import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Remote MCP shim: the SAME agent surface as src/index.ts, but reaching a DEPLOYED tester-huester over
// HTTPS instead of the local SQLite file. This is what a project's chat on your own machine uses — it can't
// touch the DB file on the VPS, so it reads the per-project REST API (GET /api/reports…?projectKey=<read_key>).
// Read-only by design: an agent pulls its project's bugs into dev context; it does not mutate triage state.
//
// Config (env):
//   TH_COLLECTOR    base URL of the deployed instance, e.g. https://qa.ihor.work
//   TH_PROJECT_KEY  the project's read_key (thr_…) — shown per-site on the dashboard
const BASE = (process.env.TH_COLLECTOR || '').replace(/\/+$/, '')
const KEY = process.env.TH_PROJECT_KEY || ''
if (!BASE) console.error('[mcp-remote] TH_COLLECTOR is not set (e.g. https://qa.ihor.work) — every call will fail.')
if (!KEY) console.error('[mcp-remote] TH_PROJECT_KEY is not set (the project read_key thr_…) — every call will fail.')

const STATUS = z.enum(['new', 'triaged', 'fixed', 'wontfix'])
const TYPE = z.enum(['feature', 'bug', 'fix', 'text'])

async function api(path: string, params: Record<string, string | number | undefined> = {}): Promise<string> {
  const url = new URL(BASE + path)
  url.searchParams.set('projectKey', KEY)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    return `network error reaching ${BASE}: ${String(e)}`
  }
  const body = await res.text()
  if (!res.ok) {
    const hint =
      res.status === 401 ? ' (TH_PROJECT_KEY missing)' : res.status === 403 ? ' (TH_PROJECT_KEY invalid for this project)' : res.status === 404 ? ' (not found or not in this project)' : ''
    return `HTTP ${res.status}${hint}: ${body.slice(0, 300)}`
  }
  return body
}

const server = new McpServer({ name: 'tester-huester-remote', version: '0.1.0' })

server.tool(
  'list_reports',
  'List captured QA reports for THIS project (newest first) from the deployed tester-huester. Optionally filter by status and/or type (feature|bug|fix|text).',
  { status: STATUS.optional(), type: TYPE.optional(), limit: z.number().int().min(1).max(500).optional() },
  async ({ status, type, limit }) => ({
    content: [{ type: 'text', text: await api('/api/reports', { status, type, limit }) }],
  }),
)

server.tool(
  'get_report',
  'Get one report by id (note, screenshot URL, page URL, status, type, severity, metadata) from this project.',
  { id: z.string() },
  async ({ id }) => ({ content: [{ type: 'text', text: await api(`/api/reports/${encodeURIComponent(id)}`) }] }),
)

server.tool(
  'get_repro_steps',
  'Get an agent-ready reproduction for a report: numbered user steps (from the recorded action trail) plus a triage summary (console errors, failed network requests, environment).',
  { id: z.string() },
  async ({ id }) => ({ content: [{ type: 'text', text: await api(`/api/reports/${encodeURIComponent(id)}/repro`) }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`tester-huester remote MCP ready (stdio) → ${BASE || '(no TH_COLLECTOR)'}`)
