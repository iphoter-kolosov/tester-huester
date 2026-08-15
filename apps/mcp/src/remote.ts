import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { STATUS_NEEDS_REVIEW, normalizeIdentity, type Report } from '@th/db'
import {
  ACK_AGENT_DOC,
  ACK_UPDATES_DOC,
  AGENT_DOC,
  ASSIGNEE_DOC,
  ASSIGN_TASK_DOC,
  COMMENT_DOC,
  CREATE_TASK_DOC,
  CREATE_TASK_REMOTE_NOTE,
  DEFAULT_SEVERITY,
  DEFAULT_TYPE,
  EVIDENCE_DOC,
  FILTER,
  GET_UPDATES_DOC,
  MY_TASKS_DOC,
  SET_STATUS_DOC,
  SEVERITY,
  SINCE_DOC,
  STATUS,
  SUBMIT_REPORT_DOC,
  TASK_SCAN_LIMIT,
  TYPE,
  VERIFY_STEPS_DOC,
  VERIFY_URL_DOC,
  WAIT_FOR_UPDATES_DOC,
  buildPlate,
  checkLinks,
  composeTaskNote,
  taskFiled,
  taskReporter,
} from './contract.ts'

// Remote MCP shim: the SAME agent surface as src/index.ts, but reaching a DEPLOYED tester-huester over HTTPS
// instead of the local SQLite file. This is what a project's chat on your own machine uses — it can't touch the
// DB file on the VPS, so it goes through the per-project REST API (…?projectKey=<read_key>).
//
// The board is agents working with each other, not one owner posting bugs: an agent can file a task FOR another
// agent, take work, hand it back with a work report, and accept or reject the work on tickets IT filed. The rules
// for all of that live in @th/db (checkStatusTransition) and are enforced by the collector — this file only has
// to speak the same vocabulary, which is why the wording comes from ./contract.ts, shared with the local server.
//
// Config (env):
//   TH_COLLECTOR    base URL of the deployed instance, e.g. https://qa.ihor.work
//   TH_PROJECT_KEY  the project's read_key (thr_…) — shown per-site on the dashboard. Read + status writes.
//   TH_AGENT        (optional) the identity this server acts under; per-call `agent` overrides it. Unset, the
//                   collector attributes writes to the project NAME, which is what pre-identity clients got.
//   TH_INGEST_KEY   (optional) the project's ingest_key (th_…). ONLY create_task needs it: a read key is
//                   read-scoped by design, so without this the board can be worked but not added to.
const BASE = (process.env.TH_COLLECTOR || '').replace(/\/+$/, '')
const KEY = process.env.TH_PROJECT_KEY || ''
const INGEST_KEY = process.env.TH_INGEST_KEY || ''
const ENV_IDENTITY = normalizeIdentity(process.env.TH_AGENT)
if (!BASE) console.error('[mcp-remote] TH_COLLECTOR is not set (e.g. https://qa.ihor.work) — every call will fail.')
if (!KEY) console.error('[mcp-remote] TH_PROJECT_KEY is not set (the project read_key thr_…) — every call will fail.')

/** Auth that a failing call was using, so the hint can name the RIGHT key instead of a plausible one. */
type Auth = 'projectKey' | 'ingestKey'

function hint(status: number, auth: Auth): string {
  if (status === 401) return auth === 'ingestKey' ? ' (TH_INGEST_KEY missing or not an ingest key of this account)' : ' (TH_PROJECT_KEY missing)'
  if (status === 403) return ' (TH_PROJECT_KEY invalid for this project)'
  if (status === 404) return ' (not found or not in this project)'
  return ''
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
  if (!res.ok) return `HTTP ${res.status}${hint(res.status, 'projectKey')}: ${body.slice(0, 300)}`
  return body
}

/**
 * Scoped write. `projectKey` auth covers everything the read key may do (status, assignee, comments, acks) — the
 * collector only allows it on reports that belong to THIS project. Creation is the exception: /api/ingest wants
 * an ingest key in the BODY and no projectKey at all, hence the switch.
 */
async function send(
  path: string,
  payload: Record<string, unknown>,
  opts: { method?: 'PATCH' | 'POST'; auth?: Auth } = {},
): Promise<string> {
  const auth: Auth = opts.auth ?? 'projectKey'
  const url = new URL(BASE + path)
  if (auth === 'projectKey') url.searchParams.set('projectKey', KEY)
  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? 'PATCH',
      headers: { Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return `network error reaching ${BASE}: ${String(e)}`
  }
  const body = await res.text()
  if (!res.ok) return `HTTP ${res.status}${hint(res.status, auth)}: ${body.slice(0, 300)}`
  return body
}

// ── who is speaking, and which board ────────────────────────────────────────────────────────────────────────

type ProjectRef = { id: string; name: string }
let cachedProject: ProjectRef | null = null

/**
 * The project behind TH_PROJECT_KEY. The collector names it on every list read, so one cheap call answers both
 * questions this shim has about itself: which id to file into (an ingest key may deposit into ANY project of the
 * account — passing the id explicitly is what guarantees the task lands on THIS board), and what to call itself
 * when no identity was declared.
 */
async function projectRef(): Promise<ProjectRef | { err: string }> {
  if (cachedProject) return cachedProject
  const text = await api('/api/reports', { limit: 1 })
  let parsed: { project?: { id?: unknown; name?: unknown } }
  try {
    parsed = JSON.parse(text) as { project?: { id?: unknown; name?: unknown } }
  } catch {
    return { err: `could not read this project from ${BASE}: ${text.slice(0, 300)}` }
  }
  const id = parsed.project?.id
  const name = parsed.project?.name
  if (typeof id !== 'string' || !id || typeof name !== 'string') {
    return { err: `unexpected answer from ${BASE}/api/reports (no project block): ${text.slice(0, 300)}` }
  }
  cachedProject = { id, name }
  return cachedProject
}

/** What to put in `agent` on a write. Undefined is legitimate: the collector then falls back to the project name,
 *  exactly as it does for clients written before identities existed. */
function declaredIdentity(agent: string | undefined): string | undefined {
  return normalizeIdentity(agent) ?? ENV_IDENTITY ?? undefined
}

/**
 * The identity for calls that cannot delegate the question to the collector — a filtered journal read is relative
 * to somebody, and a filed ticket needs a creator. The fallback chain is the collector's own (declared → project
 * name → project id), so what you read your inbox as is what your writes are attributed to.
 */
async function actingIdentity(agent: string | undefined): Promise<{ id: string } | { err: string }> {
  const declared = declaredIdentity(agent)
  if (declared) return { id: declared }
  const ref = await projectRef()
  if ('err' in ref) {
    return { err: `cannot tell who you are: TH_AGENT is not set and the project name could not be read — ${ref.err}` }
  }
  return { id: normalizeIdentity(ref.name) ?? ref.id }
}

const say = (text: string) => ({ content: [{ type: 'text' as const, text }] })

const server = new McpServer({ name: 'tester-huester-remote', version: '0.2.0' })

server.tool(
  'list_reports',
  'List captured QA reports for THIS project (newest first) from the deployed tester-huester. Optionally filter by status and/or type (feature|bug|fix|text). For "what is on MY plate" use my_tasks instead.',
  { status: STATUS.optional(), type: TYPE.optional(), limit: z.number().int().min(1).max(500).optional() },
  async ({ status, type, limit }) => say(await api('/api/reports', { status, type, limit })),
)

server.tool(
  'my_tasks',
  MY_TASKS_DOC,
  {
    agent: z.string().optional().describe(AGENT_DOC),
    status: STATUS.optional().describe('Narrow every bucket to one status, e.g. needs_review to see only what awaits your verdict.'),
  },
  async ({ agent, status }) => {
    const who = await actingIdentity(agent)
    if ('err' in who) return say(who.err)
    const text = await api('/api/reports', { limit: TASK_SCAN_LIMIT, status })
    let parsed: { reports?: unknown }
    try {
      parsed = JSON.parse(text) as { reports?: unknown }
    } catch {
      return say(`could not read the board: ${text.slice(0, 300)}`)
    }
    if (!Array.isArray(parsed.reports)) return say(`unexpected answer from ${BASE}/api/reports: ${text.slice(0, 300)}`)
    return say(JSON.stringify(buildPlate(parsed.reports as Report[], who.id), null, 2))
  },
)

server.tool(
  'get_report',
  'Get one report by id (note, screenshot URL, page URL, status, type, severity, who filed it, who holds it, metadata) plus its whole comment thread.',
  { id: z.string() },
  async ({ id }) => say(await api(`/api/reports/${encodeURIComponent(id)}`)),
)

server.tool(
  'get_repro_steps',
  "Get an agent-ready reproduction: the VISUAL EVIDENCE first (whether a screen recording exists, the reporter's chosen watch range, and the extracted frames with timestamps — LOOK AT THESE IMAGES, you cannot play video), then numbered user steps, console errors, failed requests and environment. Always call this before theorising about a ticket that has a recording.",
  { id: z.string() },
  async ({ id }) => say(await api(`/api/reports/${encodeURIComponent(id)}/repro`)),
)

server.tool(
  'wait_for_updates',
  WAIT_FOR_UPDATES_DOC,
  {
    seconds: z.number().int().min(1).max(55).optional().describe('How long to block before giving up (default 30, max 55).'),
    limit: z.number().int().min(1).max(200).optional(),
    agent: z.string().optional().describe(AGENT_DOC),
    filter: z.array(FILTER).min(1).optional().describe('Any subset of inbox | review | rework. Omit for the whole project.'),
  },
  async ({ seconds, limit, agent, filter }) => {
    const who = filter?.length ? await actingIdentity(agent) : null
    if (who && 'err' in who) return say(who.err)
    return say(
      await api('/api/updates', {
        wait: seconds ?? 30,
        limit,
        agent: who && 'id' in who ? who.id : undefined,
        filter: filter?.join(','),
      }),
    )
  },
)

server.tool(
  'get_updates',
  GET_UPDATES_DOC,
  {
    since: z.number().int().min(0).optional().describe(SINCE_DOC),
    limit: z.number().int().min(1).max(200).optional(),
    agent: z.string().optional().describe(AGENT_DOC),
    filter: z.array(FILTER).min(1).optional().describe('Any subset of inbox | review | rework. Omit for the whole project.'),
  },
  async ({ since, limit, agent, filter }) => {
    const who = filter?.length ? await actingIdentity(agent) : null
    if (who && 'err' in who) return say(who.err)
    return say(
      await api('/api/updates', {
        since,
        limit,
        agent: who && 'id' in who ? who.id : undefined,
        filter: filter?.join(','),
      }),
    )
  },
)

server.tool(
  'ack_updates',
  ACK_UPDATES_DOC,
  { cursor: z.number().int().min(0), agent: z.string().optional().describe(ACK_AGENT_DOC) },
  async ({ cursor, agent }) => say(await send('/api/updates', { cursor, agent: normalizeIdentity(agent) }, { method: 'POST' })),
)

server.tool(
  'add_comment',
  "Post a comment on a report in THIS project — report back what you did (commit/PR, what was actually wrong), why you could not reproduce it, or what you need from the reporter. Attach `verifyUrl` and `verifySteps` whenever your comment makes a claim about behaviour — the dashboard turns them into a one-click 'Проверить' block. A comment does NOT move the ticket: to hand work back for checking use submit_report.",
  {
    id: z.string(),
    body: z.string().min(1).max(4000),
    verifyUrl: z.string().url().optional().describe(VERIFY_URL_DOC),
    verifySteps: z.array(z.string().min(1).max(300)).max(12).optional().describe(VERIFY_STEPS_DOC),
  },
  async ({ id, body, verifyUrl, verifySteps }) =>
    say(await send(`/api/reports/${encodeURIComponent(id)}/comments`, { body, verifyUrl, verifySteps }, { method: 'POST' })),
)

server.tool(
  'list_comments',
  "Read the comment thread on a report in this project (previous agent notes, work reports and the reporter's replies), oldest first.",
  { id: z.string() },
  async ({ id }) => say(await api(`/api/reports/${encodeURIComponent(id)}/comments`)),
)

server.tool(
  'set_status',
  SET_STATUS_DOC,
  {
    id: z.string(),
    status: STATUS,
    agent: z.string().optional().describe(AGENT_DOC),
    comment: z.string().min(1).max(4000).optional().describe(`${COMMENT_DOC} Required for needs_review, rejected and wontfix.`),
    verifyUrl: z.string().url().optional().describe(`${VERIFY_URL_DOC} Required for needs_review.`),
    verifySteps: z.array(z.string().min(1).max(300)).max(12).optional().describe(`${VERIFY_STEPS_DOC} Required for needs_review.`),
    evidence: z.string().min(1).max(2000).optional().describe(`${EVIDENCE_DOC} Required for needs_review.`),
  },
  async ({ id, status, agent, comment, verifyUrl, verifySteps, evidence }) =>
    say(
      await send(`/api/reports/${encodeURIComponent(id)}`, {
        status,
        agent: declaredIdentity(agent),
        comment,
        verifyUrl,
        verifySteps,
        evidence,
      }),
    ),
)

server.tool(
  'submit_report',
  SUBMIT_REPORT_DOC,
  {
    id: z.string(),
    comment: z.string().min(1).max(4000).describe(`WHAT. ${COMMENT_DOC}`),
    verifyUrl: z.string().url().describe(`WHERE. ${VERIFY_URL_DOC}`),
    verifySteps: z.array(z.string().min(1).max(300)).min(1).max(12).describe(`HOW. ${VERIFY_STEPS_DOC}`),
    evidence: z.string().min(1).max(2000).describe(`PROOF. ${EVIDENCE_DOC}`),
    agent: z.string().optional().describe(AGENT_DOC),
  },
  async ({ id, comment, verifyUrl, verifySteps, evidence, agent }) =>
    say(
      await send(`/api/reports/${encodeURIComponent(id)}`, {
        status: STATUS_NEEDS_REVIEW,
        agent: declaredIdentity(agent),
        comment,
        verifyUrl,
        verifySteps,
        evidence,
      }),
    ),
)

server.tool(
  'assign_task',
  ASSIGN_TASK_DOC,
  {
    id: z.string(),
    assignee: z.string().nullable().describe(`${ASSIGNEE_DOC} null clears it.`),
    agent: z.string().optional().describe(AGENT_DOC),
  },
  async ({ id, assignee, agent }) => {
    // An assignee that normalises to nothing is not "unassign" — that is what null is for. Refusing here keeps a
    // typo from quietly detaching a ticket from the agent who was supposed to get it.
    if (assignee !== null && !normalizeIdentity(assignee)) {
      return say('assignee must be a short identity like "mcp-core" — send null (not an empty string) to clear it.')
    }
    return say(await send(`/api/reports/${encodeURIComponent(id)}`, { assignee, agent: declaredIdentity(agent) }))
  },
)

server.tool(
  'create_task',
  CREATE_TASK_DOC + CREATE_TASK_REMOTE_NOTE,
  {
    assignee: z.string().min(1).describe(ASSIGNEE_DOC),
    title: z.string().min(1).max(200).describe('One line: what must be true when this is done.'),
    body: z.string().min(1).max(4000).describe('The instruction itself: what is wrong now, where, and what counts as done.'),
    type: TYPE.optional().describe(`Defaults to ${DEFAULT_TYPE}.`),
    severity: SEVERITY.optional().describe(`Defaults to ${DEFAULT_SEVERITY}.`),
    links: z.array(z.string()).max(10).optional().describe('Absolute http(s) links to the screen, PR or spec. The first one becomes the ticket page URL.'),
    agent: z.string().optional().describe(`${AGENT_DOC} You are filing as this identity, and only this identity (or the owner) can later accept the work.`),
  },
  async ({ assignee, title, body, type, severity, links, agent }) => {
    if (!INGEST_KEY) {
      return say(
        'create_task needs TH_INGEST_KEY: the project read key in TH_PROJECT_KEY is read-scoped by design and ' +
          'cannot create tickets. Take the ingest key (th_…) from the dashboard next to this project and add it to ' +
          "this MCP server's env, then retry.",
      )
    }
    const to = normalizeIdentity(assignee)
    if (!to) return say('assignee must be a short identity like "mcp-core" — the task has to be FOR somebody.')
    const checked = checkLinks(links)
    if (!checked.ok) return say(checked.message)
    const who = await actingIdentity(agent)
    if ('err' in who) return say(who.err)
    // The id, not the key's own project: an ingest key may deposit into any project of the account, and a task
    // filed onto the wrong board is invisible to the agent it was written for.
    const ref = await projectRef()
    if ('err' in ref) return say(ref.err)

    const answer = await send(
      '/api/ingest',
      {
        ingestKey: INGEST_KEY,
        projectId: ref.id,
        note: composeTaskNote(title, body, checked.links),
        creator: who.id,
        assignee: to,
        reporter: taskReporter(who.id),
        pageUrl: checked.links[0] ?? null,
        type: type ?? DEFAULT_TYPE,
        severity: severity ?? DEFAULT_SEVERITY,
      },
      { method: 'POST', auth: 'ingestKey' },
    )
    // Answered in the same words as the local server: this is the one tool whose reply carries an id the agent
    // has to keep, and it must not read differently depending on which transport it is talking through.
    let created: { id?: unknown }
    try {
      created = JSON.parse(answer) as { id?: unknown }
    } catch {
      return say(`the task may not have been filed — the collector answered: ${answer.slice(0, 300)}`)
    }
    if (typeof created.id !== 'string') return say(`the task was not filed: ${answer.slice(0, 300)}`)
    return say(taskFiled(created.id, who.id, to))
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(
  `tester-huester remote MCP ready (stdio) → ${BASE || '(no TH_COLLECTOR)'}` +
    `${ENV_IDENTITY ? ` as "${ENV_IDENTITY}"` : ''}${INGEST_KEY ? '' : ' — create_task disabled (no TH_INGEST_KEY)'}`,
)
