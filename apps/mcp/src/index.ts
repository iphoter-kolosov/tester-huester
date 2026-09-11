import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  repo,
  buildInstructions,
  checkAssignee,
  checkHandover,
  checkStatusTransition,
  normalizeAgentRole,
  normalizeAgentTitle,
  normalizeIdentity,
  normalizeVerifyUrl,
  normalizeSteps,
  STATUS_NEEDS_REVIEW,
  type ChangeEvent,
  type IdentityView,
  type Report,
  type RosterView,
  type UpdateFilter,
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
  BAD_ROLE_MESSAGE,
  BAD_TITLE_MESSAGE,
  COMMENT_DOC,
  CREATE_TASK_DOC,
  CREATE_TASK_NEEDS_ASSIGNEE,
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
  SET_STATUS_DOC,
  mintSession,
  sessionCollisionWarning,
  SEVERITY,
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
import { buildRepro } from '../../web/lib/repro.ts'

// The MCP surface against the LOCAL SQLite file — the same tools the remote shim (src/remote.ts) offers over
// HTTPS, and deliberately the same wording (see ./contract.ts): an agent that learned one server must not be
// surprised by the other.
//
// What the board is: agents working for each other. One agent files a task FOR another (create_task), the
// executor takes it and hands the work back with a report (submit_report), and only the agent that FILED the
// ticket — or the owner — may accept or reject it. Those rules are not restated here; they live in @th/db
// (checkStatusTransition) and are applied by the same call the HTTP routes make, so the two transports cannot
// drift into two opinions about what closing a ticket costs.
//
// Config (env):
//   SQLITE_FILE     the database file (defaults to the repo root th.db)
//   TH_PROJECT_KEY  pins every tool to ONE project (accepts the read_key OR the ingest_key). Unset → all
//                   projects, with a warning; fine for a single-tenant local demo.
//   TH_AGENT        the identity this server acts under, and its entry on the roster; per-call `agent` overrides
//                   it. Unset, writes are signed with the PROJECT NAME — see the warning printed at startup and
//                   whoami. Still optional: refusing to start would take a running agent offline over a name.

const RAW_KEY = process.env.TH_PROJECT_KEY || ''
const scoped = RAW_KEY ? repo.getProjectByReadKey(RAW_KEY) ?? repo.getProjectByKey(RAW_KEY) : null
if (RAW_KEY && !scoped) {
  console.error(`[mcp] TH_PROJECT_KEY is set but matches no project — refusing to broaden scope. Check the key.`)
}
if (!RAW_KEY) {
  console.error('[mcp] TH_PROJECT_KEY not set — serving ALL projects. Set it (read_key or ingest_key) to scope to one site.')
}
// A key was supplied but did not resolve to a project - rotated, typo'd, or from another instance. This is an
// explicit boolean rather than a sentinel string: the previous sentinel was written with an invisible NUL in it
// (a shell heredoc collapsed the escape), so every `=== ' nomatch'` guard silently compared false and the tools
// answered "nothing new" forever instead of saying the key was wrong. A flag cannot rot that way.
const keyRejected = !!RAW_KEY && !scoped
const scopeId: string | null = scoped ? scoped.id : null

const ENV_IDENTITY = normalizeIdentity(process.env.TH_AGENT)
/** What an unscoped server calls itself: there is no project name to speak under, and this is the author name
 *  this server has always written into the thread in that case. */
const UNSCOPED_IDENTITY = 'agent'

/** The name a write is signed with when nobody declared one — the board's, which is precisely the fallback whoami
 *  and the startup warning exist to make visible. */
function boardIdentity(): string {
  if (!scoped) return UNSCOPED_IDENTITY
  return normalizeIdentity(scoped.name) ?? scoped.id
}

/**
 * Who this call is FROM. Same chain as the HTTP route's actor (declared → configured → project name → project
 * id), so a status set through MCP and one set through REST are attributed to the same agent and land in the same
 * inbox. The identity is canonical, which is also why the comment thread now shows it lowercased: one identity,
 * not a display name here and a key there.
 */
function acting(agent: string | undefined): ActingIdentity {
  return resolveActing(agent, ENV_IDENTITY, boardIdentity())
}

/** Reads do not need to know where the name came from; writes do. */
function actingIdentity(agent: string | undefined): string {
  return acting(agent).identity
}

/**
 * Resolve who is writing AND record that it acted — the local twin of what every write route on the collector
 * does, and it runs BEFORE the request is judged: an agent that declared a name has acted whatever the verdict,
 * and registering first is what lets it address a ticket to itself on its very first call.
 *
 * `rosterHandle` is null when nothing was declared, and nothing is registered in that case: putting the board's own
 * name on the roster is how "erental" and "photoking agents" came to look like agents.
 */
function signWrite(agent: string | undefined): ActingIdentity {
  const who = acting(agent)
  if (who.rosterHandle) repo.touchAgent(who.rosterHandle, scopeId)
  heartbeat()
  return who
}

// ── this process's session ────────────────────────────────────────────────────────────────────────────────
// One fingerprint per process, kept for its whole life, so the journal can record WHICH process wrote each entry
// and whoami can see when another process is signing under the same handle. Minted with the same helper the remote
// shim uses — a session feature that behaved differently on the two servers would be its own trap.
const SESSION = mintSession()

/** The identity this PROCESS runs under, and the handle its session is grouped by. Per-call `agent` can still
 *  override one write, but a session belongs to a process, and the collision worth shouting about is many
 *  processes sharing one handle — so the session is opened under the process default. */
const SESSION_AGENT = ENV_IDENTITY ?? boardIdentity()

// Announce the session immediately, not on first write: a second fork must be visible the moment it starts, or the
// first agent to call whoami would be told it is alone when it is not.
repo.openSession({ sessionId: SESSION.sessionId, agent: SESSION_AGENT, projectId: scopeId, origin: SESSION.origin, startedAt: SESSION.startedAt })

/**
 * Keep the session warm. `last_seen` is what makes a session "live"; every action moves it, so a working process
 * stays present and a crashed one ages out of the window on its own. If the row is gone (a wiped or swapped DB file
 * mid-run) it is re-opened rather than the heartbeat failing in silence — the session must not simply vanish.
 */
function heartbeat(): void {
  if (!repo.touchSession(SESSION.sessionId)) {
    repo.openSession({ sessionId: SESSION.sessionId, agent: SESSION_AGENT, projectId: scopeId, origin: SESSION.origin, startedAt: SESSION.startedAt })
  }
}

// Tools that need ONE project (they read the per-project cursor, or have to file into a single board) rather than
// "all projects": returns the reason to refuse, or null when the call may proceed with a real scopeId.
function needsProject(tool: string): string | null {
  if (keyRejected) return `${tool}: TH_PROJECT_KEY did not match any project on this instance - check the key on the dashboard (projects -> agent).`
  if (!scopeId) return `${tool} needs TH_PROJECT_KEY (a single project); this server is running unscoped.`
  return null
}

const owned = (r: Report | null): r is Report =>
  !!r && !keyRejected && (scopeId === null || r.projectId === scopeId)

const say = (text: string) => ({ content: [{ type: 'text' as const, text }] })

/**
 * One status transition, validated and then written — the local twin of PATCH /api/reports/:id. Both set_status
 * and submit_report go through here so there is a single write path: validate first, and touch nothing at all if
 * the transition is refused.
 */
function applyStatus(
  id: string,
  status: string,
  fields: { comment?: string; verifyUrl?: string; verifySteps?: string[]; evidence?: string },
  identity: string,
): string {
  const report = repo.resolveReport(id)
  if (!owned(report)) return `no report ${id}`
  const body: Record<string, unknown> = {
    comment: fields.comment,
    verifyUrl: fields.verifyUrl,
    verifySteps: fields.verifySteps,
    evidence: fields.evidence,
  }
  const decision = checkStatusTransition(
    status,
    body,
    { status: report.status, creator: report.creator, takenBy: report.takenBy, pageUrl: report.pageUrl },
    { kind: 'agent', identity },
  )
  if (!decision.ok) return `${decision.err.error}: ${decision.err.message}`
  if (!repo.setStatus(report.id, decision.status)) return `no report ${id}`
  // A work report from nobody leaves the filer with no one to send the rework back to.
  if (decision.takenBy) repo.setTaken(report.id, decision.takenBy)
  repo.logEvent({ projectId: report.projectId, reportId: report.id, kind: 'status', actor: identity, detail: `${report.status} → ${decision.status}`, session: SESSION.sessionId })
  if (decision.claim) {
    repo.addComment({
      reportId: report.id,
      author: identity,
      authorKind: 'agent',
      body: decision.claim.body,
      verifyUrl: decision.claim.verifyUrl,
      verifySteps: decision.claim.verifySteps,
      evidence: decision.claim.evidence,
    })
    repo.logEvent({ projectId: report.projectId, reportId: report.id, kind: 'comment', actor: identity, detail: decision.claim.body.slice(0, 200), session: SESSION.sessionId })
  }
  return `report ${report.shortId} → ${decision.status} as "${identity}"${decision.claim?.verifyUrl ? ` (check: ${decision.claim.verifyUrl})` : ''}`
}

/**
 * The journal read, filtered or not — the local twin of GET /api/updates. `cursor` is the value to ack in BOTH
 * modes: the last event seq when unfiltered, and how far the window was SCANNED when filtered, because acking the
 * last matching event would silently drop everything the filter skipped inside that same window.
 */
function readEvents(
  projectId: string,
  since: number,
  identity: string,
  filters: UpdateFilter[],
  limit: number,
): { events: ChangeEvent[]; cursor: number } {
  if (!filters.length) {
    const events = repo.eventsSince(projectId, since, limit)
    return { events, cursor: events.length ? events[events.length - 1]!.seq : since }
  }
  const { events, scannedTo } = repo.eventsSinceFor(projectId, since, identity, filters, limit)
  return { events, cursor: scannedTo }
}

/**
 * Whose journal position this read belongs to. A filtered read is one agent's slice of the board, so it keeps
 * its own position; an unfiltered read is the whole project and keeps the shared one, exactly as before
 * identities existed. Returned to the caller as `agent` so the ack can name the same position — the remote
 * server sends the identity to the collector under precisely the same condition.
 */
function cursorIdentity(identity: string, filters: UpdateFilter[]): string | null {
  return filters.length ? identity : null
}

/**
 * The greeting handed to every client on initialize. Computed once, at startup, from what this server can see of
 * the board right now — which for the local server is everything, since the roster is a table away.
 *
 * A rejected key is reported as an unreadable roster rather than an empty one: "nobody is here" would invite the
 * agent to believe it is alone on a board it cannot actually reach.
 */
function onboardingFacts(): { boardName: string | null; identity: IdentityView; roster: RosterView } {
  const identity: IdentityView = ENV_IDENTITY
    ? { kind: 'declared', identity: ENV_IDENTITY }
    : { kind: 'fallback', signedAs: boardIdentity() }
  const roster: RosterView = keyRejected
    ? { kind: 'unreadable', reason: 'TH_PROJECT_KEY matches no project on this instance' }
    : { kind: 'known', agents: repo.listAgents() }
  return { boardName: scoped ? scoped.name : null, identity, roster }
}

const server = new McpServer({ name: 'tester-huester', version: '0.3.0' }, { instructions: buildInstructions(onboardingFacts()) })

server.tool(
  'whoami',
  WHOAMI_DOC,
  { agent: z.string().optional().describe(`${AGENT_DOC} Pass it here to ask what WOULD be used for a call made under that name.`) },
  async ({ agent }) => {
    // Calling whoami is itself a sign of life — keep the session warm so a process that only ever polls still
    // shows as live to the next fork that checks for collisions.
    heartbeat()
    const who = acting(agent)
    // The key being rejected is the difference between "this board" and "no board at all", and it would otherwise
    // show up only as an empty answer from every other tool.
    const extraWarnings = keyRejected ? [needsProject('whoami')!] : []
    // Who else is signing under this identity right now. The list includes THIS session; sessionCollisionWarning
    // filters it out by id, so the warning fires only when there is genuinely another process.
    const live = repo.liveSessions(who.identity)
    const collisionWarning = sessionCollisionWarning(SESSION.sessionId, who.identity, live, Date.now())
    // Scoped to this project like everything else this server answers — an agent freshly assigned on THIS board,
    // even one that has never called anything here before, sees it the moment it calls the one tool it must call
    // first, rather than only if it separately remembers to ask my_tasks.
    const openTasks = openTaskCount(repo.listReports({ projectId: scopeId ?? undefined, limit: TASK_SCAN_LIMIT }), who.identity)
    return say(
      JSON.stringify(
        describeSelf({
          acting: who,
          board: scoped ? { id: scoped.id, name: scoped.name } : null,
          profile: repo.getAgent(who.identity),
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
    if (keyRejected) return say(needsProject('list_agents')!)
    const board = thisBoardOnly ? scopeId ?? undefined : undefined
    return say(JSON.stringify(rosterAnswer(repo.listAgents({ activeOnly, board })), null, 2))
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
    if (keyRejected) return say(needsProject('register_agent')!)
    const who = acting(agent)
    if (!who.rosterHandle) return say(REGISTER_NEEDS_IDENTITY)
    if (title === undefined && role === undefined && active === undefined) return say(REGISTER_NEEDS_FIELDS)
    // Validated here rather than left to the storage layer: upsertAgent stores what normalises to nothing as an
    // empty column, so an agent that sent a title of spaces would silently ERASE the one it had.
    if (title !== undefined && !normalizeAgentTitle(title)) return say(BAD_TITLE_MESSAGE)
    if (role !== undefined && !normalizeAgentRole(role)) return say(BAD_ROLE_MESSAGE)
    repo.upsertAgent({ handle: who.rosterHandle, title, role, active, board: scopeId })
    // Describing yourself is also an act, so the liveness stamp moves — and the row is read back afterwards to
    // answer with the stamp the board will actually show, not the one from a moment before.
    repo.touchAgent(who.rosterHandle, scopeId)
    const profile = repo.getAgent(who.rosterHandle)
    if (!profile) return say(`register_agent: "${who.rosterHandle}" was written but cannot be read back — the roster table is not answering.`)
    return say(JSON.stringify(registeredAnswer(profile), null, 2))
  },
)

server.tool(
  'list_reports',
  'List captured QA reports, newest first. Optionally filter by status and/or type (feature|bug|fix|text). Scoped to the configured project when TH_PROJECT_KEY is set. For "what is on MY plate" use my_tasks instead.',
  { status: STATUS.optional(), type: TYPE.optional(), limit: z.number().int().min(1).max(500).optional() },
  async ({ status, type, limit }) => {
    // A rejected key must never widen to "all projects": scopeId is null both when unscoped (allowed) and when
    // the key failed to resolve (forbidden), so the flag — not the id — is what decides.
    if (keyRejected) return say(needsProject('list_reports')!)
    return say(JSON.stringify(repo.listReports({ projectId: scopeId ?? undefined, status, type, limit }), null, 2))
  },
)

server.tool(
  'my_tasks',
  MY_TASKS_DOC,
  {
    agent: z.string().optional().describe(AGENT_DOC),
    status: STATUS.optional().describe('Narrow every bucket to one status, e.g. needs_review to see only what awaits your verdict.'),
  },
  async ({ agent, status }) => {
    if (keyRejected) return say(needsProject('my_tasks')!)
    const reports = repo.listReports({ projectId: scopeId ?? undefined, status, limit: TASK_SCAN_LIMIT })
    return say(JSON.stringify(buildPlate(reports, actingIdentity(agent)), null, 2))
  },
)

server.tool(
  'get_report',
  'Get one report by id (note, screenshot URL, page URL, status, type, severity, who filed it, who holds it, metadata).',
  { id: z.string() },
  async ({ id }) => {
    const r = repo.resolveReport(id)
    return say(owned(r) ? JSON.stringify(r, null, 2) : `no report ${id}`)
  },
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
    const refuse = needsProject('wait_for_updates')
    if (refuse || !scopeId) return say(refuse ?? 'wait_for_updates needs TH_PROJECT_KEY')
    const identity = actingIdentity(agent)
    const filters: UpdateFilter[] = filter ?? []
    const reader = cursorIdentity(identity, filters)
    const since = repo.getCursor(scopeId, reader)
    const deadline = Date.now() + (seconds ?? 30) * 1000
    let out = readEvents(scopeId, since, identity, filters, limit ?? 100)
    while (!out.events.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700))
      out = readEvents(scopeId, since, identity, filters, limit ?? 100)
    }
    return say(JSON.stringify({ since, cursor: out.cursor, latest: repo.latestSeq(scopeId), agent: reader, filter: filters, count: out.events.length, events: out.events }, null, 2))
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
    const refuse = needsProject('get_updates')
    if (refuse || !scopeId) return say(refuse ?? 'get_updates needs TH_PROJECT_KEY')
    const identity = actingIdentity(agent)
    const filters: UpdateFilter[] = filter ?? []
    const reader = cursorIdentity(identity, filters)
    const from = since ?? repo.getCursor(scopeId, reader)
    const out = readEvents(scopeId, from, identity, filters, limit ?? 100)
    return say(JSON.stringify({ since: from, cursor: out.cursor, latest: repo.latestSeq(scopeId), agent: reader, filter: filters, count: out.events.length, events: out.events }, null, 2))
  },
)

server.tool(
  'ack_updates',
  ACK_UPDATES_DOC,
  { cursor: z.number().int().min(0), agent: z.string().optional().describe(ACK_AGENT_DOC) },
  async ({ cursor, agent }) => {
    const refuse = needsProject('ack_updates')
    if (refuse || !scopeId) return say(refuse ?? 'ack_updates needs TH_PROJECT_KEY')
    const reader = normalizeIdentity(agent)
    // A named ack is the cheapest honest sign that an agent is still running — it read the board and finished the
    // work. An unnamed one says nothing about anybody, so it registers nobody.
    if (reader) repo.touchAgent(reader, scopeId)
    return say(`cursor → ${repo.setCursor(scopeId, cursor, reader)}${reader ? ` (for "${reader}")` : ''}`)
  },
)

server.tool(
  'add_comment',
  "Post a comment on a report — what you did (commit/PR, the actual cause), why it could not be reproduced, or what you need from the reporter. Attach `verifyUrl` and `verifySteps` whenever the comment makes a claim about behaviour. A comment does NOT move the ticket: to hand work back for checking use submit_report.",
  {
    id: z.string(),
    body: z.string().min(1).max(4000),
    verifyUrl: z.string().url().optional().describe(VERIFY_URL_DOC),
    verifySteps: z.array(z.string().min(1).max(300)).max(12).optional().describe(VERIFY_STEPS_DOC),
    agent: z.string().optional().describe(AGENT_DOC),
  },
  async ({ id, body, verifyUrl, verifySteps, agent }) => {
    const r = repo.resolveReport(id)
    if (!owned(r)) return say(`no report ${id}`)
    const url = normalizeVerifyUrl(verifyUrl)
    if (verifyUrl && !url) return say('verifyUrl must be an absolute http(s) link')
    const author = signWrite(agent).identity
    const c = repo.addComment({ reportId: r.id, author, authorKind: 'agent', body, verifyUrl: url, verifySteps: normalizeSteps(verifySteps) })
    repo.logEvent({ projectId: r.projectId, reportId: r.id, kind: 'comment', actor: author, detail: body.slice(0, 200), session: SESSION.sessionId })
    return say(`comment added to ${id} as "${author}" (${c.id})`)
  },
)

server.tool(
  'list_comments',
  "Read the comment thread on a report (previous agent notes, work reports and the reporter's replies), oldest first.",
  { id: z.string() },
  async ({ id }) => {
    const r = repo.resolveReport(id)
    if (!owned(r)) return say(`no report ${id}`)
    return say(JSON.stringify(repo.listComments(r.id), null, 2))
  },
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
    say(applyStatus(id, status, { comment, verifyUrl, verifySteps, evidence }, signWrite(agent).identity)),
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
    say(applyStatus(id, STATUS_NEEDS_REVIEW, { comment, verifyUrl, verifySteps, evidence }, signWrite(agent).identity)),
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
    const r = repo.resolveReport(id)
    if (!owned(r)) return say(`no report ${id}`)
    const actor = signWrite(agent).identity
    // Judged against the roster, and only AFTER the caller is on it, so an agent may hand a ticket to itself on its
    // first call. A typo is refused WITH the roster rather than quietly detaching the ticket from whoever needed it.
    const roster = repo.listAgents()
    const decision = checkAssignee(assignee, roster)
    if (!decision.ok) return say(`${decision.err.error}: ${decision.err.message}`)
    const to = decision.assignee
    // Same rule the collector enforces on PATCH /api/reports/:id — this server writes straight to the database, so
    // it has to ask the same question rather than inherit the answer.
    const allowed = checkHandover(actor, to, roster)
    if (!allowed.ok) return say(`${allowed.err.error}: ${allowed.err.message}`)
    if (!repo.setAssignee(r.id, to)) return say(`no report ${id}`)
    repo.logEvent({
      projectId: r.projectId,
      reportId: r.id,
      kind: 'assigned',
      actor,
      detail: to ? `assignee: ${r.assignee ?? '—'} → ${to}` : `assignee cleared (was ${r.assignee ?? '—'})`,
      session: SESSION.sessionId,
    })
    return say(to ? `report ${r.shortId} is now for "${to}" (by "${actor}")` : `report ${r.shortId} is unassigned (by "${actor}")`)
  },
)

server.tool(
  'create_task',
  CREATE_TASK_DOC,
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
    const refuse = needsProject('create_task')
    if (refuse || !scopeId) return say(refuse ?? 'create_task needs TH_PROJECT_KEY')
    const creator = signWrite(agent).identity
    const to = normalizeIdentity(assignee)
    if (!to) return say(CREATE_TASK_NEEDS_ASSIGNEE)
    // The roster check runs after the filer is on the roster, so filing a task for yourself works on the first
    // call; the refusal carries the roster, which is the one moment the caller is actually asking who exists.
    const roster = repo.listAgents()
    const decision = checkAssignee(to, roster)
    if (!decision.ok) return say(`${decision.err.error}: ${decision.err.message}`)
    // Same rule the collector enforces on POST /api/ingest — this server files straight into the database, so it
    // has to ask the same question rather than inherit the answer.
    const allowed = checkHandover(creator, decision.assignee, roster)
    if (!allowed.ok) return say(`${allowed.err.error}: ${allowed.err.message}`)
    const checked = checkLinks(links)
    if (!checked.ok) return say(checked.message)
    const note = composeTaskNote(title, body, checked.links)

    const row = repo.createReport({
      projectId: scopeId,
      note,
      creator,
      assignee: to,
      reporter: taskReporter(creator),
      pageUrl: checked.links[0] ?? null,
      type: type ?? DEFAULT_TYPE,
      severity: severity ?? DEFAULT_SEVERITY,
    })
    repo.logEvent({ projectId: scopeId, reportId: row.id, kind: 'created', actor: creator, detail: note.slice(0, 120), session: SESSION.sessionId })
    return say(taskFiled(row.id, creator, to))
  },
)

// The payoff of the "one capture, two consumers" design: hand an agent a ready-to-replay repro —
// numbered steps (from the recorded action trail) plus a triage summary (errors, failed requests, env).
// Shares buildRepro() with the REST /api/reports/[id]/repro endpoint so the two never drift.
server.tool(
  'get_repro_steps',
  "Get an agent-ready reproduction: the VISUAL EVIDENCE first (whether a screen recording exists, the reporter's chosen watch range, and the extracted frames with timestamps — LOOK AT THESE IMAGES, you cannot play video), then numbered user steps, console errors, failed requests and environment. Always call this before theorising about a ticket that has a recording.",
  { id: z.string() },
  async ({ id }) => {
    const r = repo.resolveReport(id)
    if (!owned(r)) return say(`no report ${id}`)
    const result = buildRepro(r)
    // Even a context-less report can carry a recording; hand back the visual half rather than 'nothing here'.
    if (result.kind === 'none') return say(JSON.stringify({ message: result.message, visual: result.visual }, null, 2))
    const { report, visual, environment, steps, consoleErrors, failedRequests } = result
    return say(JSON.stringify({ report, visual, environment, steps, consoleErrors, failedRequests }, null, 2))
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(
  `tester-huester MCP server ready (stdio)${scoped ? ` — scoped to "${scoped.name}"` : ''}` +
    `${ENV_IDENTITY ? ` as "${ENV_IDENTITY}"` : ` as "${boardIdentity()}" (the board's own name — TH_AGENT is unset)`}` +
    ` [session ${SESSION.sessionId.slice(0, 8)} @ ${SESSION.origin}]`,
)
// Loud, and after the ready line so it is the last thing in the log rather than the first thing scrolled past.
if (!ENV_IDENTITY) console.error(thAgentUnsetWarning('[mcp]'))
