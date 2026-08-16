import { z } from 'zod'
import {
  LEGACY_STATUS_FIXED,
  LEGACY_STATUS_TRIAGED,
  MAX_AGENT_ROLE_LEN,
  MAX_AGENT_TITLE_LEN,
  STATUSES,
  UPDATE_FILTERS,
  normalizeIdentity,
  normalizeVerifyUrl,
  resolveSpeaker,
  type AgentProfile,
  type Report,
  type ReportType,
  type Severity,
} from '@th/db'

// The vocabulary BOTH MCP servers speak — src/index.ts (local, straight at the SQLite file) and src/remote.ts
// (the shim for a deployed collector). Everything an agent can read off a tool lives here exactly once: the
// status names, the field descriptions, the rules printed in the tool text, the defaults applied on creation.
//
// Why a third file instead of two tidy self-contained servers: a tool that exists — or behaves — differently on
// one of them is a trap for the agent that learned the other. The rules themselves stay in @th/db
// (checkStatusTransition); this module is how those rules are WORDED to the caller, and that has to be one text.
//
// The sibling of this file is @th/db's onboarding.ts — the greeting both servers send as MCP `instructions`, and
// the collector serves from GET /api/onboarding. It is agent-facing wording too, but it lives in @th/db rather
// than here because Next has to render it and this module's zod / MCP-tool dependencies do not belong in a web
// route. Tool DESCRIPTIONS (read when a tool is about to be used) stay here; the ONBOARDING (read once, by every
// agent, before anything) is there.

// ── vocabulary ──────────────────────────────────────────────────────────────────────────────────────────────

// The legacy pair rides along deliberately: a project's agent written six months ago still says 'triaged'/'fixed'
// and the collector still maps them (→ taken / needs_review). Dropping them from the enum would make the MCP
// client refuse the call before the collector ever got the chance to accept it.
export const STATUS = z.enum([...STATUSES, LEGACY_STATUS_TRIAGED, LEGACY_STATUS_FIXED])
export const FILTER = z.enum([...UPDATE_FILTERS])
export const TYPE = z.enum(['feature', 'bug', 'fix', 'text'])
export const SEVERITY = z.enum(['low', 'med', 'high', 'crit'])

/** Applied by BOTH servers before the write, never left to the storage layer: the local server inserts the row
 *  itself while the remote one posts to /api/ingest, and a default living in only one of those paths would make
 *  the same create_task call produce two different tickets. */
export const DEFAULT_TYPE: ReportType = 'bug'
export const DEFAULT_SEVERITY: Severity = 'med'

/** The collector clips a note at this length; the local path has to clip identically or the same task filed
 *  through the two servers reads differently. */
export const NOTE_MAX = 5000

/** How far back my_tasks looks. The board is newest-first, so this is "the current working set" — and the answer
 *  reports when the window was full, rather than quietly showing a partial plate. */
export const TASK_SCAN_LIMIT = 500

/** Enough of the note to recognise the ticket; the full text comes from get_report. */
const NOTE_PREVIEW = 200

/** Heading of the links block inside a filed task. Russian: this text is rendered on the owner's dashboard. */
const LINKS_HEADING = 'Ссылки:'
/** Marks the card as filed by an agent rather than captured by a human with the extension. */
const AGENT_REPORTER_SUFFIX = ' (агент)'

// ── field descriptions ──────────────────────────────────────────────────────────────────────────────────────

export const AGENT_DOC =
  'The identity you act under, e.g. "mcp-core". Omit to use TH_AGENT from the environment and, failing that, ' +
  'the project name — but that last one signs your work with the BOARD\'s name instead of yours; whoami says ' +
  'which of the three is happening. This identity is also your ROSTER entry: acting under it puts you on the ' +
  'roster, register_agent describes it, and other agents address work to it (list_agents). The identity you ' +
  'WRITE under is the identity your inbox is READ under, so keep it stable — a ticket filed as "core" cannot ' +
  'be accepted by "core-stage".'

export const COMMENT_DOC =
  'What was actually wrong and what changed, with the commit/PR. This is the text the other side acts on.'

export const VERIFY_URL_DOC =
  'Absolute http(s) link landing on the exact screen (or the commit/PR) — as deep as possible, never the site root.'

export const VERIFY_STEPS_DOC =
  'Short steps saying HOW to check it, in the order the reviewer should do them. The reviewer is another agent ' +
  'that was not in your session: it cannot guess what "obviously" means.'

export const EVIDENCE_DOC =
  'What PROVES the work: the test that now passes and its output, the build line, the request/response, a ' +
  'screenshot URL. "Should work" is not evidence.'

export const ASSIGNEE_DOC = [
  'The handle of the agent this ticket is FOR. Addressing is HOW a task reaches somebody: it lands in that agent\'s',
  'inbox (get_updates filter="inbox", my_tasks → assigned). An unaddressed task reaches nobody — it sits on the board',
  'until someone happens to look. The handle must be on the roster: call list_agents first and pick a real one; an',
  'unknown handle is refused WITH the roster attached, never quietly filed into the void.',
].join(' ')

export const SINCE_DOC =
  'Read from this journal position instead of the project cursor. Omit in normal use.'

export const AGENT_TITLE_DOC =
  'Human name for the roster and the dashboard, e.g. "MCP-ядро". Short — the roster is one line per agent.'

export const AGENT_ROLE_DOC =
  'What you DO and what you answer for, in a sentence or two. This is what another agent reads before deciding ' +
  'to hand you a task, so write the responsibility ("owns the MCP servers and their contract; does not touch the ' +
  'dashboard"), not what you are made of.'

export const AGENT_ACTIVE_DOC =
  'false retires you: the entry stays readable so old threads still make sense, but nobody is offered you as an ' +
  'assignee any more. Send true to come back.'

// ── who this server is, and where that came from ────────────────────────────────────────────────────────────

/**
 * Where the acting identity came from. It is a separate answer from the identity itself because the three are not
 * equally trustworthy: the first two were DECLARED by somebody, the third is the board's own name standing in for
 * an agent that never named itself — the mechanism that filled the live threads with "erental" and "photoking
 * agents" and made two agents on one board indistinguishable.
 */
export type IdentitySource = 'declared' | 'env' | 'fallback'

/** `rosterHandle` is null exactly when the identity was inferred: a guess may sign a row, never enter the roster. */
export type ActingIdentity = { identity: string; rosterHandle: string | null; source: IdentitySource }

/**
 * The identity chain both servers use — per-call `agent`, then TH_AGENT, then the board's own name — resolved in
 * one place so a ticket filed through the local server and one filed through the remote are attributed the same.
 *
 * @param perCall  the `agent` argument of the tool call, unvalidated
 * @param envIdentity  TH_AGENT, already canonical (null when unset)
 * @param fallback  what to sign with when nobody declared anything, already canonical
 */
export function resolveActing(perCall: unknown, envIdentity: string | null, fallback: string): ActingIdentity {
  const own = normalizeIdentity(perCall)
  const declared = own ?? envIdentity
  const speaker = resolveSpeaker(declared, fallback)
  return { ...speaker, source: own ? 'declared' : declared ? 'env' : 'fallback' }
}

const ORIGIN: Record<IdentitySource, string> = {
  declared: 'the `agent` argument you passed on this call',
  env: "TH_AGENT in this server's environment",
  fallback:
    "NOBODY — no identity was declared, so this is the BOARD's own name standing in for one. It is a fallback, not a name you chose",
}

/** Said at startup and again in whoami, because a server that has been running for a week is never restarted to read a warning. */
export function thAgentUnsetWarning(prefix: string): string {
  return [
    `${prefix} TH_AGENT is NOT set — every write from this server is signed with the BOARD's name, not with an agent identity.`,
    `${prefix} Two agents on one board then merge into one indistinguishable voice, and no task can be addressed to either.`,
    `${prefix} Fix: set TH_AGENT=<your-handle> in this server's environment, or pass \`agent\` on every call. Call whoami to see what is in use.`,
  ].join('\n')
}

const FALLBACK_WARNING =
  'You have no identity of your own: writes are signed with the board\'s name. Nobody can address a task to you, ' +
  'and a second agent on this board would sign with the same name — the two of you would be one voice in every ' +
  'thread. Set TH_AGENT=<your-handle> in this server\'s environment, or pass `agent` on every call.'

const UNREGISTERED_WARNING =
  'You are not on the roster yet, so other agents reading your handle have no idea what you do. It appears there ' +
  'the moment you write anything under this identity; register_agent is what gives it a title and a role.'

const NO_ROLE_WARNING =
  'Your roster entry has no role: other agents see a bare handle and have to guess whether the work is yours, and ' +
  'create_task and assign_task are refused (role_required) until you write one. Call register_agent with a role.'

const RETIRED_WARNING =
  'Your roster entry is retired (active:false): nobody is offered you as an assignee. Call register_agent with ' +
  'active:true if you are back at work.'

const NEXT_SET_IDENTITY = 'Set TH_AGENT (or pass `agent`) so your work is signed with your own name.'
const NEXT_REGISTER = 'Call register_agent with a title and a role, so the roster says who you are.'
const NEXT_LIST = 'Call list_agents before create_task/assign_task — an unknown addressee is refused, and an unaddressed task reaches nobody.'

export type WhoAmI = {
  identity: string
  source: IdentitySource
  origin: string
  registered: boolean
  roster: { title: string; role: string; active: boolean; lastSeen: number; boards: string[] } | null
  board: { id: string; name: string } | null
  warnings: string[]
  next: string[]
}

/**
 * The answer to "who am I". An agent that cannot say this cannot introduce itself honestly, which is why the
 * warnings are part of the answer rather than a separate health check nobody would call: whoami is the one tool
 * an agent has a reason to call before it knows anything is wrong.
 */
export function describeSelf(x: {
  acting: ActingIdentity
  board: { id: string; name: string } | null
  profile: AgentProfile | null
  extraWarnings?: string[]
}): WhoAmI {
  const { acting, profile } = x
  const warnings = [...(x.extraWarnings ?? [])]
  const next: string[] = []
  if (acting.source === 'fallback') {
    warnings.push(FALLBACK_WARNING)
    next.push(NEXT_SET_IDENTITY)
  }
  if (!profile) {
    warnings.push(UNREGISTERED_WARNING)
    next.push(NEXT_REGISTER)
  } else {
    if (!profile.role) {
      warnings.push(NO_ROLE_WARNING)
      next.push(NEXT_REGISTER)
    }
    if (!profile.active) warnings.push(RETIRED_WARNING)
  }
  next.push(NEXT_LIST)
  return {
    identity: acting.identity,
    source: acting.source,
    origin: ORIGIN[acting.source],
    registered: !!profile,
    roster: profile
      ? { title: profile.title, role: profile.role, active: profile.active, lastSeen: profile.lastSeen, boards: profile.boards }
      : null,
    board: x.board,
    warnings,
    next,
  }
}

/** One shape for the roster whichever server answered: the local one reads the table and the remote one relays the
 *  collector, and an agent that learned to read one answer must not have to relearn the other. */
export function rosterAnswer(agents: AgentProfile[]): { count: number; agents: AgentProfile[] } {
  return { count: agents.length, agents }
}

/** Likewise for a registration: the local server writes the row and the remote relays the collector's, and the two
 *  answers are re-shaped through here rather than each returning whatever its own layer happened to hand back. */
export function registeredAnswer(agent: AgentProfile): { agent: AgentProfile } {
  return { agent }
}

/** Refusing to register the fallback is the whole roster fix: a board name on the roster is a board wearing an
 *  agent's face, and it is what other agents would then address work to. */
export const REGISTER_NEEDS_IDENTITY = [
  'register_agent writes YOUR entry, and this server has no identity of its own — TH_AGENT is unset and no `agent`',
  'was passed, so writes are signed with the board\'s name. Registering THAT would put a board on the roster as if it',
  'were an agent, which is the exact defect the roster exists to fix.',
  'Set TH_AGENT=<your-handle> in this server\'s environment, or pass `agent` on this call, then register.',
].join(' ')

/** The one refusal create_task must make itself on both transports: an ingest that accepts a null assignee is
 *  right to (a ticket may be unaddressed), but a HANDOVER with nobody on the other end is not a handover. */
export const CREATE_TASK_NEEDS_ASSIGNEE =
  'create_task has to be FOR somebody: send `assignee` as the handle of a real agent, e.g. "mcp-core". A task ' +
  'addressed to nobody reaches nobody — call list_agents to see who exists and what each one does.'

export const REGISTER_NEEDS_FIELDS =
  'register_agent needs at least one of `title`, `role`, `active` — describing yourself is the point of it. To only ' +
  'say "I am alive", any ordinary call already does that.'

/** Worded as the collector words them, so the same mistake reads the same through either server. */
export const BAD_TITLE_MESSAGE = `bad_title: "title" must be a short human name (up to ${MAX_AGENT_TITLE_LEN} characters), e.g. "MCP-ядро".`
export const BAD_ROLE_MESSAGE = `bad_role: "role" must say in one or two sentences (up to ${MAX_AGENT_ROLE_LEN} characters) what this agent DOES and answers for — it is what another agent reads before addressing work to it.`

// ── tool descriptions ───────────────────────────────────────────────────────────────────────────────────────

export const WHOAMI_DOC = [
  'WHO THIS SERVER WRITES AS: the identity your tickets, comments and status changes are signed with, where that',
  'identity came from, which board you are pinned to, and what the roster says about you.',
  '',
  'Call it once at the start of a session, before you introduce yourself in a thread. If `source` is "fallback" you',
  'have no identity of your own — the writes are signed with the BOARD\'s name, which is how threads ended up signed',
  '"erental" and "photoking agents" instead of by an agent, and how two agents on one board become one voice.',
  '',
  '`registered` says whether you are on the roster and `roster.role` what it says you do. An agent nobody can look up',
  'is an agent nobody addresses work to — register_agent fixes that. `warnings` and `next` say what to do about it.',
].join('\n')

export const LIST_AGENTS_DOC = [
  'WHO EXISTS on this board and what each of them does. CALL THIS BEFORE ADDRESSING A TASK (create_task, assign_task):',
  'it is the only way to learn which handle is the right receiver, and an address that is not on the roster is refused.',
  '',
  'Each entry: `handle` — exactly what goes in `assignee`; `title` and `role` — what that agent is responsible for,',
  'READ IT rather than guessing from the handle; `lastSeen` — a long-silent agent may never pick the work up;',
  '`active` — false means retired, it takes no new work; `boards` — where it works.',
  '',
  'An agent appears here the first time it writes under a declared identity, and describes itself with register_agent.',
  'A handle that is in old tickets but not here is a leftover board name, not an agent — do not address work to it.',
].join('\n')

export const REGISTER_AGENT_DOC = [
  'Put YOURSELF on the roster and say what you do — the roster is meant to be filled by the agents themselves,',
  'not by hand. Do it once, early; repeat it when your responsibility changes.',
  '',
  '`role` is the half that matters: it is the sentence another agent reads before deciding whether a task is yours.',
  'Write what you are responsible for and what you do not touch.',
  '',
  'You can only ever write your OWN entry — there is no parameter naming another agent, and that is the enforcement.',
  'Correcting somebody else\'s entry is the owner\'s job, on the dashboard. Fields you leave out keep their current',
  'value, so registering again cannot blank a role you already wrote.',
].join('\n')

export const SET_STATUS_DOC = [
  'Move one ticket along the lifecycle. WHO you are decides what you may set, so pass `agent`.',
  '',
  'new → taken → needs_review → verified | rejected   (wontfix is available at any point)',
  '  • taken        — you picked it up. Nothing else required: taking a ticket is not a claim.',
  '  • needs_review — you finished and hand it back for checking. REQUIRES all four parts: `comment` (WHAT was',
  '                   wrong and what changed), `verifyUrl` (WHERE to look), `verifySteps` (HOW to check),',
  '                   `evidence` (what PROVES it). Prefer the dedicated `submit_report` tool — it demands the',
  '                   four fields up front instead of letting the server refuse you once.',
  '  • verified     — the work is ACCEPTED. Only the agent that FILED the ticket, or the owner, may set it.',
  '                   Whoever did the work cannot mark its own work accepted; the call comes back',
  '                   `not_your_call`, and the way forward is needs_review.',
  '  • rejected     — sent back for rework. Filer or owner only, and `comment` is REQUIRED: that text is the',
  '                   whole instruction the executor gets.',
  '  • wontfix      — declined. `comment` REQUIRED, saying why.',
  '',
  "Older names still work: 'triaged' → taken, 'fixed' → needs_review (that one keeps the older, lighter",
  'contract: comment + verifyUrl, no steps or evidence demanded).',
  'The comment is posted to the thread in the same call — no separate add_comment needed.',
].join('\n')

export const SUBMIT_REPORT_DOC = [
  'Hand finished work back for checking: sets the ticket to needs_review and posts the work report, one call.',
  '',
  'All four parts are required here on purpose — the reviewer is another agent that was not in your session:',
  '  comment      WHAT  — what was actually wrong and what changed, with the commit/PR',
  '  verifyUrl    WHERE — absolute http(s) link landing on the exact screen',
  '  verifySteps  HOW   — the steps to check it, in order',
  '  evidence     PROOF — the test that now passes and its output, the build line, the response',
  '',
  'You do NOT close the ticket with this — the filer (or the owner) then sets verified or rejected. Same',
  'transition as set_status(status="needs_review"); this tool just refuses to let you send it half-built.',
].join('\n')

export const CREATE_TASK_DOC = [
  'File a NEW ticket FOR another agent (or for the owner) — the only way to create one through MCP, and the way',
  'work is handed over on this board.',
  '',
  'You become the ticket\'s FILER, and that is not a formality: nobody but you (or the owner) can set it to',
  'verified or rejected when the work comes back at needs_review. File it under the identity you will still be',
  'using when it returns.',
  '',
  'Write it as you would want to receive it: `title` — one line stating what must be true when it is done;',
  '`body` — the instruction itself (what is wrong now, where, what counts as done); `links` — absolute http(s)',
  'links to the screen, PR or spec. The first link becomes the ticket\'s page URL, so the executor\'s work report',
  'has something to point at.',
  '',
  'ADDRESS IT TO A REAL AGENT: `assignee` is checked against the roster, and an unknown handle comes back refused',
  'with the roster attached rather than filed where nobody will see it. Call list_agents first and read the roles —',
  'the handle alone does not tell you whose job this is.',
  '',
  'AND SAY WHAT YOU ARE: filing for another agent needs a role on your own roster entry (register_agent {title,',
  'role}), because the executor reports its finished work back to you. Without one the call is refused,',
  '`role_required` — filing for YOURSELF is not a handover and needs nothing.',
].join('\n')

/** The remote shim cannot create with the read key alone — see remote.ts. Appended there, not here, because it
 *  is a genuine difference in what the agent must have configured, not a difference in the tool's meaning. */
export const CREATE_TASK_REMOTE_NOTE = [
  '',
  'Needs TH_INGEST_KEY (th_…) in this server\'s environment: the project read key is read-scoped by design and',
  'cannot create anything. The key is on the dashboard next to the project.',
].join('\n')

export const ASSIGN_TASK_DOC = [
  'Hand a ticket to another agent, or take it off someone: sets who the ticket is FOR. Send assignee:null to clear.',
  '',
  'This changes nothing else. It does not move the status and it posts nothing to the thread, so say WHY you are',
  'handing it over with add_comment — otherwise the receiver gets a ticket and no reason. Assigning also does not',
  'make you the filer: whoever created the ticket keeps the final word on it.',
  '',
  'The new assignee must be on the roster (list_agents); an unknown or retired handle is refused with the roster',
  'attached, because a ticket handed to a name nobody answers to is a ticket nobody works. Handing work to ANOTHER',
  'agent also needs a role on your own entry (register_agent) — without it the call is refused, `role_required`;',
  'taking a ticket for yourself needs nothing.',
].join('\n')

export const MY_TASKS_DOC = [
  'What is on YOUR plate, in three buckets, from one call:',
  '  • assigned — addressed to you: the work you are expected to do.',
  '  • filed    — filed BY you: you are the only agent who can accept (verified) or send back (rejected) the',
  '               work on these. The ones sitting at needs_review are waiting on your verdict.',
  '  • held     — you are holding them right now (you took them, or you reported on them).',
  '',
  'Use this to pick work up after a restart; use get_updates to hear about changes as they happen. It scans only',
  'the newest tickets, and the answer says `scanned`/`truncated` so a full window is never mistaken for a full plate.',
].join('\n')

const CURSOR_RULE = [
  'Ack with the `cursor` from the ANSWER, never with the last event seq you saw: a filtered read walks a whole',
  'window of the journal, and the cursor is how far it LOOKED. Ack anything else and the events the filter',
  'skipped are dropped in silence. Ack only after the work is done — crashing before the ack replays them.',
  'Pass the same `agent` to ack_updates that the answer reports: each agent on a board keeps its own position,',
  'and acking under a different name moves a position you are not reading from.',
].join('\n')

export const ACK_UPDATES_DOC = [
  'Mark changes up to `cursor` as handled, so the next get_updates/wait_for_updates returns only newer ones.',
  '',
  CURSOR_RULE,
].join('\n')

export const ACK_AGENT_DOC =
  'The identity whose position to move — the `agent` echoed by the answer you are acking. Omit only if that ' +
  'answer reported no agent.'

const FILTER_RULE = [
  'Pass `filter` (together with `agent`) to narrow it to what concerns you:',
  '  • inbox  — tickets addressed to you and still new: someone gave you work.',
  '  • review — tickets YOU filed that reached needs_review: someone is waiting on your verdict.',
  '  • rework — tickets rejected that are yours to redo.',
  'Unknown filter names are refused, never ignored — a filter that is silently dropped turns a narrow question',
  'into "give me everything" and you would not find out.',
].join('\n')

export const GET_UPDATES_DOC = [
  'Changes in this project since the last acknowledged position, without waiting — the cheap catch-up after a',
  'restart: you get what changed (ticket id, kind, who did it, detail) instead of the whole board.',
  '',
  FILTER_RULE,
  '',
  CURSOR_RULE,
].join('\n')

export const WAIT_FOR_UPDATES_DOC = [
  'BLOCK until something happens in this project — a new ticket, a status move, an edit, a reply — then return',
  'those changes. One call instead of re-listing the board, and it returns within a second of the change.',
  'Returns immediately if changes are already pending; an empty answer just means the wait elapsed.',
  '',
  FILTER_RULE,
  '',
  CURSOR_RULE,
].join('\n')

// ── shared shaping ──────────────────────────────────────────────────────────────────────────────────────────

/** One ticket as it appears in a list: enough to recognise and route it, without the repro bundle and the media
 *  URLs that make a full report expensive to read. get_report is one call away when the detail is wanted. */
export type BriefReport = {
  id: string
  shortId: string
  status: string
  type: string
  severity: string | null
  note: string
  creator: string | null
  assignee: string | null
  takenBy: string | null
  pageUrl: string | null
  createdAt: number
}

export function brief(r: Report): BriefReport {
  return {
    id: r.id,
    shortId: r.shortId,
    status: r.status,
    type: r.type,
    severity: r.severity,
    note: r.note.slice(0, NOTE_PREVIEW),
    creator: r.creator,
    assignee: r.assignee,
    takenBy: r.takenBy,
    pageUrl: r.pageUrl,
    createdAt: r.createdAt,
  }
}

export type TaskPlate = {
  agent: string
  scanned: number
  truncated: boolean
  assigned: BriefReport[]
  filed: BriefReport[]
  held: BriefReport[]
}

/**
 * Split a window of the board into the three questions an agent asks about itself.
 *
 * `identity` must already be canonical (normalizeIdentity) — the stored columns are, and this is a plain equality
 * test: hand it raw text like "Core Stage" and every bucket comes back empty, which reads exactly like "nothing
 * to do".
 */
export function buildPlate(reports: Report[], identity: string): TaskPlate {
  const mine = (v: string | null): boolean => !!v && v === identity
  return {
    agent: identity,
    scanned: reports.length,
    truncated: reports.length >= TASK_SCAN_LIMIT,
    assigned: reports.filter((r) => mine(r.assignee)).map(brief),
    filed: reports.filter((r) => mine(r.creator)).map(brief),
    held: reports.filter((r) => mine(r.takenBy)).map(brief),
  }
}

/** The note as the owner and the executor will read it on the card: the headline, the instruction, the links. */
export function composeTaskNote(title: string, body: string, links: string[]): string {
  const blocks = [title.trim(), body.trim()]
  if (links.length) blocks.push([LINKS_HEADING, ...links.map((l) => `- ${l}`)].join('\n'))
  return blocks.filter(Boolean).join('\n\n').slice(0, NOTE_MAX)
}

/** Who the card says filed it. `creator` carries the machine-readable identity; this is the human-readable half. */
export function taskReporter(identity: string): string {
  return identity + AGENT_REPORTER_SUFFIX
}

/** The answer to create_task. Shared because it is the one reply carrying an id the caller must keep, and an
 *  agent that learned to read it from one server would otherwise have to relearn it on the other. */
export function taskFiled(id: string, creator: string, assignee: string): string {
  return `task filed by "${creator}" for "${assignee}" — id ${id}`
}

/**
 * Links are refused, not quietly dropped: a task whose "see here" link vanished between filing and reading sends
 * the executor hunting for a page nobody named.
 */
export function checkLinks(links: string[] | undefined): { ok: true; links: string[] } | { ok: false; message: string } {
  if (!links?.length) return { ok: true, links: [] }
  const normalized = links.map((l) => ({ raw: l, url: normalizeVerifyUrl(l) }))
  const bad = normalized.filter((l) => !l.url).map((l) => l.raw)
  if (bad.length) {
    return {
      ok: false,
      message: `Not absolute http(s) links, so nothing was filed: ${bad.join(', ')}. Send full links (https://…) or leave them out.`,
    }
  }
  return { ok: true, links: normalized.map((l) => l.url!) }
}
