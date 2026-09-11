import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  STATUS_NEEDS_REVIEW,
  buildInstructions,
  normalizeIdentity,
  type AgentProfile,
  type AgentSession,
  type IdentityView,
  type Report,
  type RosterView,
} from '@th/db'
import {
  ACK_AGENT_DOC,
  ACK_UPDATES_DOC,
  AGENT_ACTIVE_DOC,
  AGENT_DOC,
  AGENT_ROLE_DOC,
  AGENT_TITLE_DOC,
  ASSIGNEE_DOC,
  ASSIGN_TASK_DOC,
  COMMENT_DOC,
  CREATE_TASK_DOC,
  CREATE_TASK_NEEDS_ASSIGNEE,
  CREATE_TASK_REMOTE_NOTE,
  DEFAULT_SEVERITY,
  DEFAULT_TYPE,
  EVIDENCE_DOC,
  FILTER,
  GET_UPDATES_DOC,
  LIST_AGENTS_DOC,
  MY_TASKS_DOC,
  REGISTER_AGENT_DOC,
  REGISTER_NEEDS_FIELDS,
  REGISTER_NEEDS_IDENTITY,
  SESSION_ENDPOINT,
  SET_STATUS_DOC,
  SEVERITY,
  mintSession,
  sessionCollisionWarning,
  sessionEndpointUnavailable,
  SINCE_DOC,
  STATUS,
  SUBMIT_REPORT_DOC,
  TASK_SCAN_LIMIT,
  TYPE,
  VERIFY_STEPS_DOC,
  VERIFY_URL_DOC,
  WAIT_FOR_UPDATES_DOC,
  WHOAMI_DOC,
  buildPlate,
  checkLinks,
  composeTaskNote,
  describeSelf,
  openTaskCount,
  registeredAnswer,
  resolveActing,
  rosterAnswer,
  taskFiled,
  taskReporter,
  thAgentUnsetWarning,
  type ActingIdentity,
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
//   TH_AGENT        the identity this server acts under, and its entry on the collector's roster; per-call `agent`
//                   overrides it. Unset, the collector attributes writes to the project NAME and registers nobody
//                   — see the warning printed at startup and whoami. Still optional: refusing to start would take
//                   a running agent offline over a name.
//   TH_INGEST_KEY   (optional) the project's ingest_key (th_…). ONLY create_task needs it: a read key is
//                   read-scoped by design, so without this the board can be worked but not added to.
const BASE = (process.env.TH_COLLECTOR || '').replace(/\/+$/, '')
const KEY = process.env.TH_PROJECT_KEY || ''
const INGEST_KEY = process.env.TH_INGEST_KEY || ''
const ENV_IDENTITY = normalizeIdentity(process.env.TH_AGENT)

// This process's session fingerprint — minted once, kept for its life, the same helper the local server uses so
// the two are indistinguishable in how they name a session. The collector, which owns the sessions table, is told
// about it through SESSION_ENDPOINT; every write also carries the id so the journal records which fork wrote it.
const SESSION = mintSession()

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

/** A refused address answers with the whole ROSTER in `message` — that is the point of the refusal, and clipping it
 *  short would leave the caller with "unknown_assignee" and no way to find out who it should have written to. */
const MAX_ERROR_TEXT = 4000

/**
 * A collector refusal as the agent needs to read it. The API answers `{ok:false, error, message}` where `message`
 * is written FOR the caller; passing it through verbatim — in the same `code: message` shape the local server
 * produces — is what keeps a refusal instructive instead of merely negative.
 */
function explain(status: number, body: string, auth: Auth): string {
  const raw = `HTTP ${status}${hint(status, auth)}: ${body.slice(0, MAX_ERROR_TEXT)}`
  let parsed: { error?: unknown; message?: unknown }
  try {
    parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
  } catch {
    return raw
  }
  const code = typeof parsed.error === 'string' ? parsed.error : ''
  const message = typeof parsed.message === 'string' ? parsed.message : ''
  if (!code) return raw
  return message ? `${code}: ${message.slice(0, MAX_ERROR_TEXT)}` : `${code}${hint(status, auth)}`
}

async function api(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const url = new URL(BASE + path)
  url.searchParams.set('projectKey', KEY)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  let res: Response
  try {
    // No timeout by default — wait_for_updates is a long poll and a deadline here would cut it off. Only the
    // startup lookups pass one, because nothing may hold the process between spawn and "ready".
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    })
  } catch (e) {
    return `network error reaching ${BASE}: ${String(e)}`
  }
  const body = await res.text()
  if (!res.ok) return explain(res.status, body, 'projectKey')
  return body
}

/**
 * Whether the collector accepted the write, kept separate from the text of its answer. A caller that PARSES the
 * answer needs to know: a refusal is not malformed JSON, it is the collector explaining what to do instead, and
 * treating the two alike is how create_task came to wrap "unknown_assignee" — roster and all — in a guess and then
 * clip it mid-sentence.
 */
type SendResult = { ok: true; body: string } | { ok: false; text: string }

/** What to show the agent, refusal or not — both are written for it to read. */
const said = (r: SendResult): string => (r.ok ? r.body : r.text)

/**
 * Scoped write. `projectKey` auth covers everything the read key may do (status, assignee, comments, acks) — the
 * collector only allows it on reports that belong to THIS project. Creation is the exception: /api/ingest wants
 * an ingest key in the BODY and no projectKey at all, hence the switch.
 */
async function send(
  path: string,
  payload: Record<string, unknown>,
  opts: { method?: 'PATCH' | 'POST'; auth?: Auth; timeoutMs?: number } = {},
): Promise<SendResult> {
  const auth: Auth = opts.auth ?? 'projectKey'
  const url = new URL(BASE + path)
  if (auth === 'projectKey') url.searchParams.set('projectKey', KEY)
  let res: Response
  try {
    // No deadline by default — an agent write must complete, not be cut off. A caller that runs during startup
    // (the session announce) passes one, because nothing may hold the process between spawn and "ready".
    res = await fetch(url, {
      method: opts.method ?? 'PATCH',
      headers: { Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    })
  } catch (e) {
    return { ok: false, text: `network error reaching ${BASE}: ${String(e)}` }
  }
  const body = await res.text()
  if (!res.ok) return { ok: false, text: explain(res.status, body, auth) }
  return { ok: true, body }
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
async function projectRef(opts: { timeoutMs?: number } = {}): Promise<ProjectRef | { err: string }> {
  if (cachedProject) return cachedProject
  const text = await api('/api/reports', { limit: 1 }, opts)
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
 *  exactly as it does for clients written before identities existed — and registers nobody, which is the point. */
function declaredIdentity(agent: string | undefined): string | undefined {
  return normalizeIdentity(agent) ?? ENV_IDENTITY ?? undefined
}

/**
 * The identity for calls that cannot delegate the question to the collector — a filtered journal read is relative
 * to somebody, and a filed ticket needs a creator. The fallback chain is the collector's own (declared → project
 * name → project id), so what you read your inbox as is what your writes are attributed to.
 *
 * The project name is fetched only when nothing was declared: that round trip exists purely to name the fallback.
 */
async function actingIdentity(agent: string | undefined): Promise<ActingIdentity | { err: string }> {
  const declared = declaredIdentity(agent)
  if (declared) return resolveActing(agent, ENV_IDENTITY, declared)
  const ref = await projectRef()
  if ('err' in ref) {
    return { err: `cannot tell who you are: TH_AGENT is not set and the project name could not be read — ${ref.err}` }
  }
  return resolveActing(undefined, null, normalizeIdentity(ref.name) ?? ref.id)
}

/**
 * The roster from the collector. Parsed rather than relayed as text because whoami has to look itself up in it and
 * list_agents has to answer in the same shape the local server does.
 */
async function fetchRoster(
  params: { active?: string; board?: string } = {},
  opts: { timeoutMs?: number } = {},
): Promise<AgentProfile[] | { err: string }> {
  const text = await api('/api/agents', params, opts)
  let parsed: { agents?: unknown }
  try {
    parsed = JSON.parse(text) as { agents?: unknown }
  } catch {
    return { err: `could not read the roster from ${BASE}: ${text.slice(0, 300)}` }
  }
  if (!Array.isArray(parsed.agents)) return { err: `unexpected answer from ${BASE}/api/agents: ${text.slice(0, 300)}` }
  return parsed.agents as AgentProfile[]
}

/**
 * Announce this process's session to the collector (or refresh it) and read back who else is live under `agent`.
 * The shim has no database, so this one endpoint does both jobs the local server does against the table directly:
 * register the fork, and hand back the live set whoami turns into a collision warning. A failure is RETURNED, not
 * swallowed — a collision we could not check for is worse left unsaid than said plainly.
 */
async function registerSession(agent: string, opts: { timeoutMs?: number } = {}): Promise<AgentSession[] | { err: string }> {
  const answer = await send(
    SESSION_ENDPOINT,
    { session: SESSION.sessionId, agent, origin: SESSION.origin, startedAt: SESSION.startedAt },
    { method: 'POST', timeoutMs: opts.timeoutMs },
  )
  if (!answer.ok) return { err: sessionEndpointUnavailable(BASE, answer.text) }
  let parsed: { sessions?: unknown }
  try {
    parsed = JSON.parse(answer.body) as { sessions?: unknown }
  } catch {
    return { err: `could not read live sessions from ${BASE}${SESSION_ENDPOINT}: ${answer.body.slice(0, 300)}` }
  }
  if (!Array.isArray(parsed.sessions)) return { err: `unexpected answer from ${BASE}${SESSION_ENDPOINT}: ${answer.body.slice(0, 300)}` }
  return parsed.sessions as AgentSession[]
}

const say = (text: string) => ({ content: [{ type: 'text' as const, text }] })

/**
 * How long the greeting may keep the process from being ready. The board is worth naming, but not at the price of
 * an agent that never launches because its collector is down, so the lookups are on a short leash.
 */
const BOOT_LOOKUP_MS = 4000

/** The failure is quoted into the greeting, which every request then carries — enough to recognise, not the page. */
const BOOT_REASON_MAX = 200

/**
 * The greeting, built before the transport is connected — instructions are sent once, on initialize, so there is
 * no later moment to fill them in.
 *
 * This is the one place the shim asks the collector a question it does not need in order to work, which is why an
 * unanswered question is NOT fatal: an agent on a board it can name is better than an agent that will not start.
 * The failure is carried into the text itself ("the roster could not be read — call list_agents") and shouted on
 * stderr, so it is visible in both places rather than showing up as a board that looks empty.
 */
async function onboardingFacts(): Promise<{ boardName: string | null; identity: IdentityView; roster: RosterView }> {
  const unset = { err: 'TH_COLLECTOR or TH_PROJECT_KEY is not set' }
  const lookups: [Promise<ProjectRef | { err: string }>, Promise<AgentProfile[] | { err: string }>] =
    BASE && KEY
      ? [projectRef({ timeoutMs: BOOT_LOOKUP_MS }), fetchRoster({}, { timeoutMs: BOOT_LOOKUP_MS })]
      : [Promise.resolve(unset), Promise.resolve(unset)]
  const [ref, roster] = await Promise.all(lookups)
  if ('err' in roster) console.error(`[mcp-remote] the roster could not be read at startup: ${roster.err}`)
  const boardName = 'err' in ref ? null : ref.name
  return {
    boardName,
    // Without TH_AGENT the collector attributes the write to the project name, so that is what the agent is told
    // it is signing as — and when even the project could not be read, the sentence drops the name rather than
    // inventing one.
    identity: ENV_IDENTITY
      ? { kind: 'declared', identity: ENV_IDENTITY }
      : boardName
        ? { kind: 'fallback', signedAs: boardName }
        : { kind: 'unknown' },
    roster: 'err' in roster ? { kind: 'unreadable', reason: roster.err.slice(0, BOOT_REASON_MAX) } : { kind: 'known', agents: roster },
  }
}

const server = new McpServer(
  { name: 'tester-huester-remote', version: '0.3.0' },
  { instructions: buildInstructions(await onboardingFacts()) },
)

server.tool(
  'whoami',
  WHOAMI_DOC,
  { agent: z.string().optional().describe(`${AGENT_DOC} Pass it here to ask what WOULD be used for a call made under that name.`) },
  async ({ agent }) => {
    const who = await actingIdentity(agent)
    if ('err' in who) return say(who.err)
    const ref = await projectRef()
    const roster = await fetchRoster()
    // Announce (and refresh) this session, and read back who else is live under the same handle. A collector that
    // predates the endpoint returns an error string, surfaced as a warning rather than silently omitting the check.
    const live = await registerSession(who.identity)
    const collisionWarning = 'err' in live ? null : sessionCollisionWarning(SESSION.sessionId, who.identity, live, Date.now())
    // Same window my_tasks reads, fetched here too so a freshly-assigned agent's very FIRST call already says
    // "this is yours" — see openTaskCount. Best-effort: a failure here degrades to "0 open tasks", said as a
    // warning rather than failing the whole call, the same way a roster that could not be read does below.
    const reportsText = await api('/api/reports', { limit: TASK_SCAN_LIMIT })
    let openTasks = 0
    let reportsErr: string | null = null
    try {
      const parsed = JSON.parse(reportsText) as { reports?: unknown }
      if (Array.isArray(parsed.reports)) openTasks = openTaskCount(parsed.reports as Report[], who.identity)
      else reportsErr = `unexpected answer from ${BASE}/api/reports: ${reportsText.slice(0, 300)}`
    } catch {
      reportsErr = `could not check pending tasks: ${reportsText.slice(0, 300)}`
    }
    // A roster that could not be read is said out loud rather than shown as "not registered" — the two look the
    // same in the answer and mean opposite things.
    const extraWarnings = [
      ...('err' in ref ? [ref.err] : []),
      ...('err' in roster ? [roster.err] : []),
      ...('err' in live ? [live.err] : []),
      ...(reportsErr ? [reportsErr] : []),
    ]
    const profile = Array.isArray(roster) ? roster.find((a) => a.handle === who.identity) ?? null : null
    return say(
      JSON.stringify(
        describeSelf({
          acting: who,
          board: 'err' in ref ? null : { id: ref.id, name: ref.name },
          profile,
          session: { ...SESSION, collisionWarning },
          openTasks,
          extraWarnings,
        }),
        null,
        2,
      ),
    )
  },
)

server.tool(
  'list_agents',
  LIST_AGENTS_DOC,
  {
    activeOnly: z.boolean().optional().describe('Leave out retired entries — the ones that take no new work.'),
    thisBoardOnly: z
      .boolean()
      .optional()
      .describe('Only agents that have already worked THIS board. Off by default: a handle is one agent everywhere, and the one you need may simply not have touched this board yet.'),
  },
  async ({ activeOnly, thisBoardOnly }) => {
    let board: string | undefined
    if (thisBoardOnly) {
      const ref = await projectRef()
      if ('err' in ref) return say(ref.err)
      board = ref.id
    }
    const roster = await fetchRoster({ active: activeOnly ? '1' : undefined, board })
    if ('err' in roster) return say(roster.err)
    return say(JSON.stringify(rosterAnswer(roster), null, 2))
  },
)

server.tool(
  'register_agent',
  REGISTER_AGENT_DOC,
  {
    title: z.string().min(1).max(200).optional().describe(AGENT_TITLE_DOC),
    role: z.string().min(1).max(1000).optional().describe(AGENT_ROLE_DOC),
    active: z.boolean().optional().describe(AGENT_ACTIVE_DOC),
    agent: z.string().optional().describe(AGENT_DOC),
  },
  async ({ title, role, active, agent }) => {
    // Deliberately NOT actingIdentity(): that one falls back to the board's name, and registering the board is the
    // defect the roster exists to fix. Only a declared identity may enter the directory.
    const handle = declaredIdentity(agent)
    if (!handle) return say(REGISTER_NEEDS_IDENTITY)
    if (title === undefined && role === undefined && active === undefined) return say(REGISTER_NEEDS_FIELDS)
    const answer = await send('/api/agents', { agent: handle, title, role, active }, { method: 'POST' })
    if (!answer.ok) return say(answer.text)
    // Re-shaped rather than relayed, so the entry reads identically to the one the local server answers with.
    let parsed: { agent?: unknown }
    try {
      parsed = JSON.parse(answer.body) as { agent?: unknown }
    } catch {
      return say(`registered, but the answer could not be read: ${answer.body.slice(0, 300)}`)
    }
    if (!parsed.agent) return say(`unexpected answer from ${BASE}/api/agents: ${answer.body.slice(0, 300)}`)
    return say(JSON.stringify(registeredAnswer(parsed.agent as AgentProfile), null, 2))
  },
)

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
    return say(JSON.stringify(buildPlate(parsed.reports as Report[], who.identity), null, 2))
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
        agent: who && !('err' in who) ? who.identity : undefined,
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
        agent: who && !('err' in who) ? who.identity : undefined,
        filter: filter?.join(','),
      }),
    )
  },
)

server.tool(
  'ack_updates',
  ACK_UPDATES_DOC,
  { cursor: z.number().int().min(0), agent: z.string().optional().describe(ACK_AGENT_DOC) },
  async ({ cursor, agent }) => say(said(await send('/api/updates', { cursor, agent: normalizeIdentity(agent), session: SESSION.sessionId }, { method: 'POST' }))),
)

server.tool(
  'add_comment',
  "Post a comment on a report in THIS project — report back what you did (commit/PR, what was actually wrong), why you could not reproduce it, or what you need from the reporter. Attach `verifyUrl` and `verifySteps` whenever your comment makes a claim about behaviour — the dashboard turns them into a one-click 'Проверить' block. A comment does NOT move the ticket: to hand work back for checking use submit_report.",
  {
    id: z.string(),
    body: z.string().min(1).max(4000),
    verifyUrl: z.string().url().optional().describe(VERIFY_URL_DOC),
    verifySteps: z.array(z.string().min(1).max(300)).max(12).optional().describe(VERIFY_STEPS_DOC),
    agent: z.string().optional().describe(AGENT_DOC),
  },
  // Signing the comment is what stops a thread reading as if the BOARD said it: without an identity the collector
  // authors the comment as the project name, which is why the live threads are signed "erental" and "huester".
  async ({ id, body, verifyUrl, verifySteps, agent }) =>
    say(
      said(
        await send(
          `/api/reports/${encodeURIComponent(id)}/comments`,
          { body, verifyUrl, verifySteps, agent: declaredIdentity(agent), session: SESSION.sessionId },
          { method: 'POST' },
        ),
      ),
    ),
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
      said(
        await send(`/api/reports/${encodeURIComponent(id)}`, {
          status,
          agent: declaredIdentity(agent),
          comment,
          verifyUrl,
          verifySteps,
          evidence,
          session: SESSION.sessionId,
        }),
      ),
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
      said(
        await send(`/api/reports/${encodeURIComponent(id)}`, {
          status: STATUS_NEEDS_REVIEW,
          agent: declaredIdentity(agent),
          comment,
          verifyUrl,
          verifySteps,
          evidence,
          session: SESSION.sessionId,
        }),
      ),
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
  // The address is judged by the collector, against the roster it owns, using the same checkAssignee the local
  // server calls — so a typo and an unknown handle come back in identical words through either transport. A
  // pre-flight check here could only be a second opinion, and a staler one.
  async ({ id, assignee, agent }) =>
    say(said(await send(`/api/reports/${encodeURIComponent(id)}`, { assignee, agent: declaredIdentity(agent), session: SESSION.sessionId }))),
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
    // Only the shape is checked here — whether the handle is a REAL agent is the collector's call, and it must be:
    // it registers the filer before judging the address, which is what lets an agent file its first task for itself.
    const to = normalizeIdentity(assignee)
    if (!to) return say(CREATE_TASK_NEEDS_ASSIGNEE)
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
        creator: who.identity,
        assignee: to,
        reporter: taskReporter(who.identity),
        pageUrl: checked.links[0] ?? null,
        type: type ?? DEFAULT_TYPE,
        severity: severity ?? DEFAULT_SEVERITY,
        session: SESSION.sessionId,
      },
      { method: 'POST', auth: 'ingestKey' },
    )
    // A REFUSAL is passed through untouched. It is not a broken answer to be summarised — an unknown addressee comes
    // back with the whole roster in it, which is the one thing the caller needs and the one thing a wrapper clips.
    if (!answer.ok) return say(answer.text)
    // Answered in the same words as the local server: this is the one tool whose reply carries an id the agent
    // has to keep, and it must not read differently depending on which transport it is talking through.
    let created: { id?: unknown }
    try {
      created = JSON.parse(answer.body) as { id?: unknown }
    } catch {
      return say(`the task may not have been filed — the collector answered: ${answer.body.slice(0, 300)}`)
    }
    if (typeof created.id !== 'string') return say(`the task was not filed: ${answer.body.slice(0, 300)}`)
    return say(taskFiled(created.id, who.identity, to))
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)

// Announce the session so a second fork is visible before its first write — but AFTER connect and WITHOUT awaiting
// it: the announce is a network round trip, and a collector that is down, slow, or a black hole must never delay
// "ready" (the same reason onboardingFacts caps its lookups). It is best-effort telemetry — whoami re-announces and
// reads collisions on demand — so a failure is shouted on stderr and dropped, never made fatal. Bounded so the
// process is not left holding a socket to a hung collector.
if (BASE && KEY) {
  void (async () => {
    const bootWho = await actingIdentity(undefined)
    if ('err' in bootWho) return console.error(`[mcp-remote] session not announced at startup: ${bootWho.err}`)
    const live = await registerSession(bootWho.identity, { timeoutMs: BOOT_LOOKUP_MS })
    if ('err' in live) console.error(`[mcp-remote] ${live.err}`)
  })()
}

console.error(
  `tester-huester remote MCP ready (stdio) → ${BASE || '(no TH_COLLECTOR)'}` +
    `${ENV_IDENTITY ? ` as "${ENV_IDENTITY}"` : " as the board's own name (TH_AGENT is unset)"}` +
    `${INGEST_KEY ? '' : ' — create_task disabled (no TH_INGEST_KEY)'}` +
    ` [session ${SESSION.sessionId.slice(0, 8)} @ ${SESSION.origin}]`,
)
// Loud, and after the ready line so it is the last thing in the log rather than the first thing scrolled past.
if (!ENV_IDENTITY) console.error(thAgentUnsetWarning('[mcp-remote]'))
