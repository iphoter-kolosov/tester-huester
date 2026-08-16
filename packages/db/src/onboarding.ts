import {
  STATUS_NEEDS_REVIEW,
  STATUS_NEW,
  STATUS_REJECTED,
  STATUS_TAKEN,
  STATUS_VERIFIED,
  STATUS_WONTFIX,
  type RosterEntry,
} from './verify'
import { UPDATE_FILTERS } from './db'

// The onboarding text every agent is handed the moment it connects — the answer to "where can the agents of this
// project talk to each other, and how". It is COMPOSED from the constants the board actually enforces (verify.ts's
// lifecycle, db.ts's journal filters, the live roster), so it cannot describe a board that no longer exists.
//
// Why it lives in @th/db and not in apps/mcp/src/contract.ts, where the rest of the agent-facing wording is: this
// text has three consumers, and one of them is the collector (GET /api/onboarding, inside Next). contract.ts pulls
// in zod and the MCP tool vocabulary, neither of which belongs in a web route's dependency graph; @th/db is already
// a workspace dependency of BOTH apps and already listed in next.config transpilePackages. It is also where the
// rules themselves are (verify.ts), which is the point — the description sits next to the enforcement.
//
// Budget: this is injected into every agent's context on every session, so length is a tax paid forever. Keep it
// at a size a model reads in seconds. Detail belongs in the tool descriptions, which are only read when the tool
// is about to be used.

/** Enough of a colleague's role to route a task; the whole thing is one list_agents call away. */
const ROLE_PREVIEW = 140
/** Beyond this the greeting stops being an introduction and becomes a directory dump. */
const MAX_COLLEAGUES = 12

/** Layout of the two-column lifecycle block. */
const INDENT = 2
const SEPARATOR = ' — '

/**
 * The tools the text names. Declared here rather than written into the prose so a renamed tool is a compile
 * error in one place — and `instructions-e2e` asserts every value below is actually offered by both servers,
 * which is what keeps this list from becoming the second hand-written copy it exists to prevent.
 */
export const ONBOARDING_TOOLS = {
  whoami: 'whoami',
  listAgents: 'list_agents',
  registerAgent: 'register_agent',
  createTask: 'create_task',
  assignTask: 'assign_task',
  setStatus: 'set_status',
  submitReport: 'submit_report',
  myTasks: 'my_tasks',
  getUpdates: 'get_updates',
  waitForUpdates: 'wait_for_updates',
  ackUpdates: 'ack_updates',
  listReports: 'list_reports',
} as const

/**
 * What this server knows about the identity it writes as. Three states rather than a nullable string, because
 * "nobody declared one, so the BOARD's name is standing in" and "this text is being generated for the docs, where
 * there is no server at all" need different sentences — and a nullable string would quietly collapse them.
 */
export type IdentityView =
  | { kind: 'declared'; identity: string }
  | { kind: 'fallback'; signedAs: string }
  | { kind: 'unknown' }

/**
 * What this server knows about the roster. `unreadable` is deliberately not `known: []`: an empty board and a
 * collector that did not answer look identical in a list and mean opposite things — one invites you to be first,
 * the other means you have not seen your colleagues yet.
 */
export type RosterView =
  | { kind: 'known'; agents: RosterEntry[] }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'notLookedUp' }

export type OnboardingFacts = {
  /** The board this server is pinned to. null when it is not pinned to one (an unscoped server, or the docs). */
  boardName: string | null
  identity: IdentityView
  roster: RosterView
}

const LIFECYCLE = `${STATUS_NEW} → ${STATUS_TAKEN} → ${STATUS_NEEDS_REVIEW} → ${STATUS_VERIFIED} | ${STATUS_REJECTED}`

function headline(boardName: string | null): string {
  const where = boardName ? `the agents working on "${boardName}"` : 'the agents working this project'
  return `tester-huester — the shared board for ${where}. A ticket is how work is handed over between you; the roster is who can receive it.`
}

function identityLine(v: IdentityView): string {
  if (v.kind === 'declared') {
    return `YOU ARE "${v.identity}". Every ticket, comment and status change you make is signed with it, and it is the inbox you read.`
  }
  const signed = v.kind === 'fallback' ? `with "${v.signedAs}", the BOARD's own name` : "with the BOARD's own name"
  return [
    `YOU HAVE NO IDENTITY: your writes are signed ${signed}, you are not on the roster, and no task can be`,
    `addressed to you. Set TH_AGENT=<your-handle> in this server's environment, or pass \`agent\` on every call.`,
  ].join(' ')
}

/**
 * The lifecycle as a two-column block. Laid out by measuring rather than by hand-counted spaces: the labels are
 * built from status constants, so a renamed status would silently knock a hand-aligned block crooked.
 */
function workMoves(): string {
  const t = ONBOARDING_TOOLS
  const rows: [label: string, lines: string[]][] = [
    [`${t.createTask}(assignee=…)`, [`you become the ticket's FILER; the handle must be one from ${t.listAgents}.`]],
    [`${t.setStatus}("${STATUS_TAKEN}")`, ['the executor picked it up.']],
    [
      t.submitReport,
      [
        'hand it back: comment (WHAT) + verifyUrl (WHERE) + verifySteps (HOW) + evidence (PROOF).',
        'Any part missing is refused before anything is written.',
      ],
    ],
    [
      `${STATUS_VERIFIED} | ${STATUS_REJECTED}`,
      [
        'the FILER or the owner, nobody else. An executor cannot accept its own work; that',
        `comes back not_your_call. Handing work back is ${STATUS_NEEDS_REVIEW}, not ${STATUS_VERIFIED}.`,
      ],
    ],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  const indent = ' '.repeat(INDENT + width + SEPARATOR.length)
  const out = rows.flatMap(([label, lines]) => [
    ' '.repeat(INDENT) + label.padEnd(width) + SEPARATOR + lines[0],
    ...lines.slice(1).map((l) => indent + l),
  ])
  return ['HOW WORK MOVES:', ...out, `${' '.repeat(INDENT)}Statuses: ${LIFECYCLE}. ${STATUS_WONTFIX} at any point, with a reason.`].join('\n')
}

const clip = (s: string): string => (s.length > ROLE_PREVIEW ? s.slice(0, ROLE_PREVIEW - 1).trimEnd() + '…' : s)

/** Written here rather than reusing describeRoster(): that one is the full directory a refusal owes the caller,
 *  and this one is an introduction that every request pays for. */
function rosterBlock(v: RosterView): string {
  if (v.kind === 'unreadable') {
    return `ON THE BOARD: the roster could not be read (${v.reason}) — call ${ONBOARDING_TOOLS.listAgents}, it may answer now.`
  }
  if (v.kind === 'notLookedUp') {
    return `ON THE BOARD: call ${ONBOARDING_TOOLS.listAgents} for who is here right now, and what each of them answers for.`
  }
  const active = v.agents.filter((a) => a.active)
  if (!active.length) {
    return `ON THE BOARD: nobody yet — you would be the first. ${ONBOARDING_TOOLS.registerAgent} puts you there.`
  }
  const shown = active.slice(0, MAX_COLLEAGUES)
  const lines = shown.map((a) => `  • ${a.handle}${a.title ? ` (${a.title})` : ''} — ${clip(a.role) || 'has not said what it does yet'}`)
  const rest = active.length - shown.length
  if (rest > 0) lines.push(`  • …and ${rest} more — ${ONBOARDING_TOOLS.listAgents}.`)
  return ['ON THE BOARD:', ...lines].join('\n')
}

/**
 * The whole greeting. Pure: everything it says comes from `facts` and from the enforcing constants, so the text
 * a server hands out and the text the collector serves are the same text by construction.
 */
export function buildInstructions(facts: OnboardingFacts): string {
  const t = ONBOARDING_TOOLS
  return [
    headline(facts.boardName),
    '',
    identityLine(facts.identity),
    '',
    `FIRST, IN THIS ORDER: ${t.whoami} (what you write as, and what is wrong with it), then ${t.listAgents} before you`,
    `address anything, then ${t.registerAgent} {title, role} — the role is the sentence a colleague reads before`,
    'deciding a task is yours.',
    // The one refusal an agent can hit before it has done anything wrong, so it is stated up front rather than
    // discovered as a 400 — together with its boundary, or an agent reads it as "I am locked out".
    `THE ROLE IS A CONDITION: without one, ${t.createTask} and ${t.assignTask} are refused (role_required) — work handed`,
    'over by an agent nobody can look up leaves the executor reporting to a bare handle. Everything else works without',
    `it: reading, ${t.setStatus}, comments, ${t.submitReport}.`,
    '',
    rosterBlock(facts.roster),
    '',
    workMoves(),
    '',
    `STAYING IN TOUCH: ${t.getUpdates} to catch up, ${t.waitForUpdates} to block until something happens — both with`,
    `\`agent\` and filter ${UPDATE_FILTERS.join(' | ')}; ${t.myTasks} after a restart. ${t.ackUpdates} with the \`cursor\``,
    'FROM THE ANSWER, and only once the work is done — acking early drops the events the filter skipped, in silence.',
    '',
    `DO NOT SCAN THE BOARD on your own initiative: no ${t.listReports} "just in case", no re-reading tickets to see`,
    'whether something changed. The updates feed is how you hear; your owner says when to look.',
  ].join('\n')
}

// ── how an agent gets connected in the first place ──────────────────────────────────────────────────────────

/** What the snippet shows where the checkout path is unknowable — the collector cannot guess where the agent's
 *  copy of this repo lives, and a plausible-looking wrong path is worse than an obvious blank. */
export const REPO_PATH_PLACEHOLDER = '<path to your tester-huester checkout>'

/**
 * The `claude mcp add` line for ONE project, so the answer to "how do I join this board" is complete.
 *
 * `ingestKey` is a placeholder and never a value: this snippet is served to whoever holds the READ key, and a read
 * key that could fetch the write key would not be read-scoped at all. The line names the key and says where the
 * owner takes it from.
 */
export function buildConnectSnippet(x: { collector: string; readKey: string; repoPath?: string }): string {
  return [
    'claude mcp add tester-huester -s local \\',
    `  -e TH_COLLECTOR=${x.collector} \\`,
    `  -e TH_PROJECT_KEY=${x.readKey} \\`,
    '  -e TH_AGENT=<the-handle-this-agent-answers-to> \\',
    // The dashboard prints two keys per project on separate rows; naming the wrong row sends the owner to paste
    // the read key twice, and the failure only surfaces later, at the first create_task.
    '  -e TH_INGEST_KEY=<ingest key th_… — dashboard, projects → ingest; create_task needs it> \\',
    `  -- pnpm -C "${x.repoPath ?? REPO_PATH_PLACEHOLDER}" --filter @th/mcp remote`,
  ].join('\n')
}

/** Restarting is not optional and is the one step that is silently skipped: MCP servers are read at startup, so
 *  without it the agent keeps the old tool list and concludes the tools do not exist. */
export const CONNECT_RESTART_NOTE =
  'After adding or changing this, RESTART the agent application — MCP servers are read once at startup.'
