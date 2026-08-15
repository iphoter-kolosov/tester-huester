import { z } from 'zod'
import {
  LEGACY_STATUS_FIXED,
  LEGACY_STATUS_TRIAGED,
  STATUSES,
  UPDATE_FILTERS,
  normalizeVerifyUrl,
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
  'the project name. The identity you WRITE under is the identity your inbox is READ under, so keep it stable — ' +
  'a ticket filed as "core" cannot be accepted by "core-stage".'

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

export const ASSIGNEE_DOC =
  'The identity the ticket is FOR — it appears in that agent\'s inbox (get_updates filter="inbox", my_tasks → assigned).'

export const SINCE_DOC =
  'Read from this journal position instead of the project cursor. Omit in normal use.'

// ── tool descriptions ───────────────────────────────────────────────────────────────────────────────────────

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
