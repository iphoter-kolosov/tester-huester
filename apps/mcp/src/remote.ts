import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Remote MCP shim: the SAME agent surface as src/index.ts, but reaching a DEPLOYED tester-huester over
// HTTPS instead of the local SQLite file. This is what a project's chat on your own machine uses — it can't
// touch the DB file on the VPS, so it reads the per-project REST API (GET /api/reports…?projectKey=<read_key>).
// Scoped to one project: reads its bugs into dev context, and may set the status of its OWN reports (the
// dev agent marking a case fixed/wontfix as it works). It cannot touch other projects or move reports.
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

function hint(status: number): string {
  return status === 401
    ? ' (TH_PROJECT_KEY missing)'
    : status === 403
      ? ' (TH_PROJECT_KEY invalid for this project)'
      : status === 404
        ? ' (not found or not in this project)'
        : ''
}

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
  if (!res.ok) return `HTTP ${res.status}${hint(res.status)}: ${body.slice(0, 300)}`
  return body
}

// Scoped write: PATCH /api/reports/:id?projectKey=… { status }. The collector only allows it on reports that
// belong to THIS project's read key, so an agent can only ever change the status of its own cases.
async function patch(path: string, payload: Record<string, unknown>, method: 'PATCH' | 'POST' = 'PATCH'): Promise<string> {
  const url = new URL(BASE + path)
  url.searchParams.set('projectKey', KEY)
  let res: Response
  try {
    res = await fetch(url, { method, headers: { Accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  } catch (e) {
    return `network error reaching ${BASE}: ${String(e)}`
  }
  const body = await res.text()
  if (!res.ok) return `HTTP ${res.status}${hint(res.status)}: ${body.slice(0, 300)}`
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

server.tool(
  'wait_for_updates',
  'BLOCK until something happens in this project — a new report, a status change, an edit, or a reply from the reporter — then return those changes. Use this as your main loop instead of re-listing reports: it costs one call and returns within a second of the change. Returns immediately if changes are already pending. `seconds` is how long to wait before giving up (default 30, max 55); an empty result just means nothing happened, call it again.',
  { seconds: z.number().int().min(1).max(55).optional(), limit: z.number().int().min(1).max(200).optional() },
  async ({ seconds, limit }) => ({
    content: [{ type: 'text', text: await api('/api/updates', { wait: seconds ?? 30, limit }) }],
  }),
)

server.tool(
  'get_updates',
  'Return changes in this project since the last acknowledged position, without waiting. Cheap catch-up after a restart: you get only what changed (report id, kind, who did it, detail) instead of the whole board.',
  { since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() },
  async ({ since, limit }) => ({ content: [{ type: 'text', text: await api('/api/updates', { since, limit }) }] }),
)

server.tool(
  'ack_updates',
  'Mark changes up to `cursor` as handled, so the next wait_for_updates/get_updates returns only newer ones. Call it AFTER you have acted on them — if you crash before acking, you will safely see those changes again.',
  { cursor: z.number().int().min(0) },
  async ({ cursor }) => ({ content: [{ type: 'text', text: await patch('/api/updates', { cursor }, 'POST') }] }),
)

server.tool(
  'add_comment',
  "Post a comment on a report in THIS project — report back what you did (commit/PR, what was actually wrong), why you could not reproduce it, or what you need from the reporter. The comment is attributed to this project and appears in the ticket's thread, where the human can reply. Use it whenever you change a status, so 'fixed' is never a bare word.",
  { id: z.string(), body: z.string().min(1).max(4000) },
  async ({ id, body }) => ({ content: [{ type: 'text', text: await patch(`/api/reports/${encodeURIComponent(id)}/comments`, { body }, 'POST') }] }),
)

server.tool(
  'list_comments',
  'Read the comment thread on a report in this project (previous agent notes and the reporter\'s replies), oldest first.',
  { id: z.string() },
  async ({ id }) => ({ content: [{ type: 'text', text: await api(`/api/reports/${encodeURIComponent(id)}/comments`) }] }),
)

server.tool(
  'set_status',
  "Update the triage status of one report in THIS project as you work through it: 'triaged' when you pick it up, 'fixed' when done, 'wontfix' if declined. Only reports belonging to this project can be changed.",
  { id: z.string(), status: STATUS },
  async ({ id, status }) => ({ content: [{ type: 'text', text: await patch(`/api/reports/${encodeURIComponent(id)}`, { status }) }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`tester-huester remote MCP ready (stdio) → ${BASE || '(no TH_COLLECTOR)'}`)
