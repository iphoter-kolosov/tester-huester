import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalStatus,
  normalizeAgentRole,
  normalizeAgentTitle,
  normalizeIdentity,
  statusQueryTargets,
  IDENTITY_EXTENSION,
  IDENTITY_OWNER,
  LEGACY_ACTOR_HUMAN,
  LEGACY_STATUS_FIXED,
  LEGACY_STATUS_TRIAGED,
  SEEDED_AGENTS,
  STATUSES,
  STATUS_NEEDS_REVIEW,
  STATUS_NEW,
  STATUS_REJECTED,
  STATUS_TAKEN,
  STATUS_VERIFIED,
  STATUS_WONTFIX,
} from './verify'

// A session is "live" if it acted within this window. 10 minutes: long enough to survive a slow agent loop
// between two calls, short enough that a process which has actually exited stops counting as a collision soon
// after. Exported because the screens that read collisions must use the SAME window the storage layer buckets by.
export const SESSION_LIVE_MS = 10 * 60 * 1000
// A rostered, active agent that has not acted in this long is flagged "silent" by the system-health lens — long
// enough that an ordinary quiet spell does not trip it, short enough to catch a stuck or dead worker within a day.
export const SILENT_AGENT_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Journal actors that name nobody the roster can look up: the extension channel, an empty string, and the string
// forms a missing identity serialises to across the two languages that touch this data. Compared lowercase. The
// system-health lens counts entries under these as "unnamed-actor events" — the signal-quality problem this whole
// board exists to make visible.
const UNNAMED_ACTORS = [IDENTITY_EXTENSION, '', 'none', 'null', 'undefined']

const STATUSES_FOR_ERROR = STATUSES.join(', ')

// Zero runtime dependencies: Node 24's built-in SQLite. Works identically in plain Node (seed, mcp) and in
// Next's server runtime (node: builtins are always external), so none of the wasm/native-addon pain.
// The columns map 1:1 to the eventual Postgres schema — only the access layer changes for production.
function defaultFile(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)) // packages/db/src
    return path.resolve(here, '../../../th.db') // repo root
  } catch {
    return path.resolve(process.cwd(), 'th.db')
  }
}
const file = path.resolve(process.env.SQLITE_FILE || defaultFile())

// Lazy, memoized connection. Opened on the FIRST query — never at module import — so that build-time module
// evaluation (Next's "collecting page data") does not touch the filesystem when there is no DB / SQLITE_FILE.
// The cache also survives Next's dev hot-reload.
const g = globalThis as unknown as { __thsqlite?: DatabaseSync }
function db(): DatabaseSync {
  if (g.__thsqlite) return g.__thsqlite
  const c = new DatabaseSync(file)
  g.__thsqlite = c
  c.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      name text NOT NULL,
      ingest_key text NOT NULL UNIQUE,
      created_at integer NOT NULL
    );
    -- Facts about the database itself. Its only job so far is to record that a one-way data backfill already
    -- ran, so a restart cannot run it a second time over rows that now mean something different.
    CREATE TABLE IF NOT EXISTS meta (
      key text PRIMARY KEY,
      value text NOT NULL
    );
    -- One journal position PER AGENT, because several agents now share a board. With a single position per
    -- project, whichever of them acked first moved the other one's starting point past events it had never been
    -- shown — and a filtered read makes that certain rather than likely, since each agent is deliberately shown
    -- only its own slice. Rows appear on first ack; until then the agent reads from the project position.
    CREATE TABLE IF NOT EXISTS agent_cursors (
      project_id text NOT NULL,
      agent text NOT NULL,
      cursor integer NOT NULL,
      PRIMARY KEY (project_id, agent)
    );
    -- Change journal. An agent asks "what happened since cursor X" instead of re-reading every ticket to
    -- discover state — one cheap call, and the row itself says what changed and who changed it.
    CREATE TABLE IF NOT EXISTS events (
      seq integer PRIMARY KEY AUTOINCREMENT,   -- monotonic cursor
      project_id text NOT NULL,
      report_id text NOT NULL,
      kind text NOT NULL,                      -- created | status | edited | comment | archived | moved
      actor text NOT NULL,                     -- an identity: joins agents.handle (see unifyOwnerActor)
      detail text,                             -- e.g. 'new -> fixed', or the comment's first line
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_project_idx ON events (project_id, seq);
    -- A running session of one agent process. Identity is a HANDLE (agent), but a handle FORKS: eRENTAL has many
    -- git worktrees and dozens of claude processes all signing as "erental". A session is one such process; more
    -- than one LIVE session under a single handle is a COLLISION the dashboard must be able to name. Addressing is
    -- unchanged — work is still addressed to a handle, never to a session — this table only makes the forks visible.
    -- origin is free provenance the process reports about itself (worktree path, pid, host); started_at is
    -- stamped once and last_seen moves on every call, so liveness is a plain last_seen-within-window test.
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id text PRIMARY KEY,
      agent      text NOT NULL,
      project_id text,
      origin     text NOT NULL DEFAULT '',
      started_at integer NOT NULL,
      last_seen  integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_sessions_agent_idx ON agent_sessions (agent, last_seen DESC);
    CREATE TABLE IF NOT EXISTS comments (
      id text PRIMARY KEY,
      report_id text NOT NULL,
      author text NOT NULL,        -- display name: the project's name for an agent, 'Вы' for the dashboard
      author_kind text NOT NULL,   -- 'agent' | 'human'
      body text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_report_idx ON comments (report_id, created_at);
    -- The roster. Until it existed, an identity was a bare self-declared string with nothing behind it: no way to
    -- learn who is on a board, what any of them does, or whether a handle in a thread is still alive. That is why
    -- the assignee column sat empty on every ticket — addressing work needs a directory to address it INTO.
    -- handle is the canonical identity (normalizeIdentity) and the join key to reports.creator / .assignee /
    -- .taken_by and events.actor; the PRIMARY KEY is that string, so a handle cannot exist twice under two casings.
    CREATE TABLE IF NOT EXISTS agents (
      handle text PRIMARY KEY,
      title text NOT NULL DEFAULT '',            -- human name for the UI
      role text NOT NULL DEFAULT '',             -- what it DOES and answers for — read before addressing it
      boards text NOT NULL DEFAULT '[]',         -- project ids, JSON: always read with the row, never joined on
      first_seen integer NOT NULL,
      last_seen integer NOT NULL,                -- so a dead agent is visibly dead instead of quietly assumed alive
      active integer NOT NULL DEFAULT 1          -- whether it should still be offered as an assignee
    );
    CREATE INDEX IF NOT EXISTS agents_last_seen_idx ON agents (last_seen DESC);
    CREATE TABLE IF NOT EXISTS reports (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      note text NOT NULL DEFAULT '',
      screenshot_url text,
      page_url text,
      viewport text,
      user_agent text,
      reporter text,
      status text NOT NULL DEFAULT 'new',
      created_at integer NOT NULL,
      context text,
      replay_url text
    );
  `)
  // Idempotent migrations for DBs created before these columns existed (e.g. the demo th.db).
  if (!columnExists(c, 'reports', 'context')) c.exec('ALTER TABLE reports ADD COLUMN context text')
  if (!columnExists(c, 'reports', 'replay_url')) c.exec('ALTER TABLE reports ADD COLUMN replay_url text')
  // Note taxonomy: `type` classifies the note (feature/bug/fix/text); `severity` is an optional triage weight.
  // `type` gets a NOT NULL DEFAULT so old rows read back as 'bug'; `severity` stays nullable (truly optional).
  if (!columnExists(c, 'reports', 'type')) c.exec("ALTER TABLE reports ADD COLUMN type text NOT NULL DEFAULT 'bug'")
  if (!columnExists(c, 'reports', 'severity')) c.exec('ALTER TABLE reports ADD COLUMN severity text')
  // Archive: a two-stage safety for removal — archive first (reversible, hidden from the active board and from
  // agents), then hard-delete only from the archive.
  if (!columnExists(c, 'reports', 'archived')) c.exec('ALTER TABLE reports ADD COLUMN archived integer NOT NULL DEFAULT 0')
  // A real recording of the tab (webm). This is the primary "what did you see" artefact; replay_url stays for
  // older reports and for the small DOM buffer.
  if (!columnExists(c, 'reports', 'video_url')) c.exec('ALTER TABLE reports ADD COLUMN video_url text')
  if (!columnExists(c, 'reports', 'video_seconds')) c.exec('ALTER TABLE reports ADD COLUMN video_seconds integer')
  // The stretch the reporter selected in the trim editor, as {from,to} seconds — the player shows only this.
  if (!columnExists(c, 'reports', 'video_trim')) c.exec('ALTER TABLE reports ADD COLUMN video_trim text')
  // Stills sampled from the recording, as [{at, url}] — the agent-readable form of the video.
  if (!columnExists(c, 'reports', 'video_frames')) c.exec('ALTER TABLE reports ADD COLUMN video_frames text')
  // Up to MAX_ATTACHMENTS extra images, each with its own baked-in markup and its own caption — "ten tickets
  // in one". A JSON column rather than a child table: the set is always read whole with the report, never
  // queried or joined on individually, and its order is part of the meaning (the reporter's numbering).
  if (!columnExists(c, 'reports', 'attachments')) c.exec('ALTER TABLE reports ADD COLUMN attachments text')
  // Per-project read key: read-only, single-project scope for an agent (REST/MCP) — no dashboard cookie, no
  // write-capable ingest key. Added nullable, then backfilled for pre-existing projects.
  if (!columnExists(c, 'projects', 'read_key')) c.exec('ALTER TABLE projects ADD COLUMN read_key text')
  // Server-side cursor per project: an agent that restarts (or crashes mid-work) resumes exactly where it left
  // off instead of losing events or re-reading the whole board.
  if (!columnExists(c, 'projects', 'agent_cursor')) c.exec('ALTER TABLE projects ADD COLUMN agent_cursor integer NOT NULL DEFAULT 0')
  // How to CHECK the claim. An agent reporting "fixed" has to say where to look (an absolute http(s) link) and,
  // when opening the link isn't self-evident, the steps to reproduce the check. Stored on the comment because
  // the claim belongs to the message that made it — a later comment can supersede it with a new link.
  if (!columnExists(c, 'comments', 'verify_url')) c.exec('ALTER TABLE comments ADD COLUMN verify_url text')
  if (!columnExists(c, 'comments', 'verify_steps')) c.exec('ALTER TABLE comments ADD COLUMN verify_steps text')
  // What PROVES the work — the fourth part of a work report, next to the three that already existed. Its own
  // column rather than prose inside `body`, because the reviewer looks for it specifically and the dashboard
  // renders it separately.
  if (!columnExists(c, 'comments', 'evidence')) c.exec('ALTER TABLE comments ADD COLUMN evidence text')
  // Addressing. Three distinct questions that `reporter` used to answer at once and badly:
  //   creator  — who FILED it (canonical identity; the only agent besides the owner allowed to accept the work)
  //   assignee — who it is FOR (null until someone is put on it)
  //   taken_by — who is HOLDING it right now, with taken_at saying since when
  // `reporter` is left exactly as it is: free human-readable text, which is what the extension collects and what
  // a person reads on the card. Promoting it would have meant rewriting live rows into an identity they never
  // had — a guess baked into the record.
  if (!columnExists(c, 'reports', 'creator')) c.exec('ALTER TABLE reports ADD COLUMN creator text')
  if (!columnExists(c, 'reports', 'assignee')) c.exec('ALTER TABLE reports ADD COLUMN assignee text')
  if (!columnExists(c, 'reports', 'taken_by')) c.exec('ALTER TABLE reports ADD COLUMN taken_by text')
  if (!columnExists(c, 'reports', 'taken_at')) c.exec('ALTER TABLE reports ADD COLUMN taken_at integer')
  // The CHANNEL a ticket arrived through, distinct from WHO filed it. A capture is the owner's action (creator =
  // owner, so he can accept his own ticket) but it still came in through the extension — `via` keeps that
  // provenance so nothing is lost when the fallback creator stops being 'extension'. Nullable: legacy rows and
  // agent-filed tickets read back null.
  if (!columnExists(c, 'reports', 'via')) c.exec('ALTER TABLE reports ADD COLUMN via text')
  // Which SESSION wrote this journal entry. Nullable on purpose: the HTTP path and every caller written before
  // sessions existed have none, and a missing session must read back cleanly as null — never as a guessed one. A
  // present value is what lets the dashboard say WHICH of an agent's forked processes made a given change.
  if (!columnExists(c, 'events', 'session')) c.exec('ALTER TABLE events ADD COLUMN session text')
  c.exec(`
    CREATE INDEX IF NOT EXISTS reports_assignee_idx ON reports (assignee, created_at);
    CREATE INDEX IF NOT EXISTS reports_creator_idx ON reports (creator, created_at);
  `)
  backfillLifecycleStatuses(c)
  backfillReadKeys(c)
  seedRoster(c)
  unifyOwnerActor(c)
  return c
}

const LIFECYCLE_BACKFILL_KEY = 'lifecycle_statuses_backfilled'
const OWNER_ACTOR_BACKFILL_KEY = 'owner_actor_unified'

/**
 * Put the owner and the extension on the roster. INSERT OR IGNORE rather than a one-shot guard: the seed must not
 * overwrite a role the owner has since edited, and "the row exists" is the only condition that matters.
 */
function seedRoster(c: DatabaseSync): void {
  const now = Date.now()
  const ins = c.prepare(
    'INSERT OR IGNORE INTO agents (handle, title, role, boards, first_seen, last_seen, active) VALUES (?,?,?,?,?,?,?)',
  )
  for (const a of SEEDED_AGENTS) ins.run(a.handle, a.title, a.role, '[]', now, now, a.active ? 1 : 0)
}

/**
 * Give the owner ONE name in the journal. The live table holds rows written as 'human' by the dashboard of the
 * time and newer ones written as 'owner'; both mean the same person, and 'human' is no longer written by anything.
 *
 * Rewritten once rather than mapped on read, which was the alternative. A read-time alias would have to be applied
 * in every place that touches events.actor — the updates route, the dashboard, the roster join added here, and
 * every consumer written after this sentence — and each of those is a fresh chance to forget it, producing a board
 * that shows two owners and an agent that can filter on only one of them. This is not rewriting history: nothing
 * about what happened changes, only the spelling of the actor's name, and it is recorded in `meta` so the pass
 * cannot run twice.
 */
function unifyOwnerActor(c: DatabaseSync): void {
  const done = c.prepare('SELECT value FROM meta WHERE key = ?').get(OWNER_ACTOR_BACKFILL_KEY)
  if (done) return
  const n = c.prepare('UPDATE events SET actor = ? WHERE actor = ?').run(IDENTITY_OWNER, LEGACY_ACTOR_HUMAN).changes
  c.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(OWNER_ACTOR_BACKFILL_KEY, `${Date.now()}:${n}`)
}

/**
 * Move the rows written under the old four-status model onto the lifecycle, ONCE.
 *
 * `fixed` becomes `verified`, not `needs_review`: those tickets were closed and accepted under the rules in
 * force at the time, and reopening them as "waiting for the filer to check" would invent a backlog of reviews
 * nobody agreed to do.
 *
 * The run is recorded because it is not idempotent in meaning, only in SQL. `setStatus` canonicalises on write,
 * so no fresh `fixed` row can appear — but if a stale client ever wrote one (meaning "claimed, unchecked"), a
 * second pass would silently promote that claim to accepted. Once is once.
 */
function backfillLifecycleStatuses(c: DatabaseSync): void {
  const done = c.prepare('SELECT value FROM meta WHERE key = ?').get(LIFECYCLE_BACKFILL_KEY)
  if (done) return
  c.prepare('UPDATE reports SET status = ? WHERE status = ?').run(STATUS_VERIFIED, LEGACY_STATUS_FIXED)
  c.prepare('UPDATE reports SET status = ? WHERE status = ?').run(STATUS_TAKEN, LEGACY_STATUS_TRIAGED)
  c.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(LIFECYCLE_BACKFILL_KEY, String(Date.now()))
}

function columnExists(c: DatabaseSync, table: string, column: string): boolean {
  const rows = c.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

// A read key is a high-entropy random token; unlike the ingest key it grants read-only, single-project scope.
function newReadKey(): string {
  return 'thr_' + crypto.randomBytes(24).toString('hex')
}

function backfillReadKeys(c: DatabaseSync): void {
  const rows = c.prepare("SELECT id FROM projects WHERE read_key IS NULL OR read_key = ''").all() as Array<{ id: string }>
  const upd = c.prepare('UPDATE projects SET read_key = ? WHERE id = ?')
  for (const r of rows) upd.run(newReadKey(), r.id)
}

export type Project = { id: string; name: string; ingestKey: string; readKey: string; createdAt: number }

/**
 * One roster row. Structurally a superset of verify.ts's RosterEntry, so it can be handed straight to
 * checkAssignee without a mapping step that could drift from what is stored.
 */
export type AgentProfile = {
  handle: string; title: string; role: string; boards: string[]
  firstSeen: number; lastSeen: number; active: boolean
}

// A hand-edited or truncated column must not crash a page that lists the roster.
function parseBoards(v: unknown): string[] {
  const parsed = parseJson(v)
  return Array.isArray(parsed) ? (parsed as unknown[]).filter((x): x is string => typeof x === 'string') : []
}

/** Board membership is a set, and the order is the order the agent first worked them. */
function mergeBoards(existing: string[], board?: string | null): string[] {
  return board && !existing.includes(board) ? [...existing, board] : existing
}

const toAgent = (r: any): AgentProfile => ({
  handle: r.handle,
  title: r.title ?? '',
  role: r.role ?? '',
  boards: parseBoards(r.boards),
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  active: !!r.active,
})
// `context` is the repro bundle (env/console/network/actions from @th/core), stored as JSON. Typed as
// unknown here to keep @th/db dependency-free; consumers cast it to ReproBundle.
// `type` classifies the note; `severity` is an optional triage weight (null on legacy rows).
export type ReportType = 'feature' | 'bug' | 'fix' | 'text'
export type Severity = 'low' | 'med' | 'high' | 'crit'

// One attached image is a first-class unit of evidence: the picture, the markup already baked into it, and the
// caption that says what to look at. Order is the reporter's numbering and is preserved as stored.
export type Attachment = { id: string; url: string; caption: string; at: number }
// Hard ceiling, enforced here so no caller can exceed it whatever the API layer believes.
export const MAX_ATTACHMENTS = 10
const CAPTION_MAX = 2000

export type Report = {
  id: string; shortId: string; projectId: string; note: string; screenshotUrl: string | null; pageUrl: string | null
  viewport: string | null; userAgent: string | null; reporter: string | null; status: string; createdAt: number
  context: unknown | null; replayUrl: string | null; videoUrl: string | null; videoSeconds: number | null
  videoTrim: { from: number; to: number } | null; videoFrames: { at: number; url: string }[] | null
  // Always an array — legacy rows (column added later, or written before it existed) read back as [] so no
  // consumer has to null-check before iterating.
  attachments: Attachment[]
  type: ReportType; severity: Severity | null; archived: boolean
  // Addressing. `reporter` above stays the free human text; these three are canonical identities (lowercase),
  // null on every row filed before the lifecycle existed.
  creator: string | null; assignee: string | null; takenBy: string | null; takenAt: number | null
  // The channel the ticket came in through (e.g. 'extension'), separate from `creator` (who filed it). Null on
  // legacy rows and on tickets an agent filed directly.
  via: string | null
}

// Accept only well-formed entries and cap the list. Used on both the write and the read path: a row written by
// an older build, or hand-edited, must not be able to crash a page that renders it.
export function normalizeAttachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return []
  const out: Attachment[] = []
  for (const raw of v) {
    if (out.length >= MAX_ATTACHMENTS) break
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (typeof a.url !== 'string' || !a.url) continue
    out.push({
      id: typeof a.id === 'string' && a.id ? a.id : crypto.randomUUID(),
      url: a.url,
      caption: typeof a.caption === 'string' ? a.caption.slice(0, CAPTION_MAX) : '',
      at: typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : Date.now(),
    })
  }
  return out
}

// The human-facing handle for a ticket: short enough to say and paste, long enough to stay unique.
export const shortId = (id: string): string => (id || '').replace(/-/g, '').slice(0, 8)

// 'assigned' joins the older kinds rather than reusing 'edited': handing a ticket to another agent is the event
// that agent is waiting for, and it has to be recognisable without parsing the detail string.
export type EventKind = 'created' | 'status' | 'edited' | 'comment' | 'archived' | 'moved' | 'assigned'

// The three questions an agent asks the journal about itself. Named here because both the REST layer and the MCP
// layer must spell them identically — an unrecognised filter name silently returning "everything" is exactly the
// kind of quiet wrongness this board exists to prevent, so callers validate against this list.
export const UPDATE_FILTERS = ['inbox', 'review', 'rework'] as const
export type UpdateFilter = (typeof UPDATE_FILTERS)[number]
// `session` is which running process wrote the entry (agent_sessions.session_id); null on the HTTP path and on
// any entry written before sessions existed — a missing session reads back as null, never as a guessed one.
export type ChangeEvent = { seq: number; projectId: string; reportId: string; kind: EventKind; actor: string; detail: string | null; session: string | null; createdAt: number }
const toEvent = (r: any): ChangeEvent => ({ seq: r.seq, projectId: r.project_id, reportId: r.report_id, kind: r.kind as EventKind, actor: r.actor, detail: r.detail ?? null, session: r.session ?? null, createdAt: r.created_at })

export type AuthorKind = 'agent' | 'human'
// `verifyUrl` / `verifySteps` are the check the author is handing over: WHERE to look and HOW. Required of an
// agent claiming 'fixed' (enforced at the API layer), optional on any other comment.
// `evidence` is what PROVES the work — the fourth part of a work report, required of an agent moving a ticket
// to needs_review.
export type Comment = {
  id: string; reportId: string; author: string; authorKind: AuthorKind; body: string; createdAt: number
  verifyUrl: string | null; verifySteps: string[] | null; evidence: string | null
}

const toProject = (r: any): Project => ({ id: r.id, name: r.name, ingestKey: r.ingest_key, readKey: r.read_key ?? '', createdAt: r.created_at })
const toComment = (r: any): Comment => ({
  id: r.id, reportId: r.report_id, author: r.author, authorKind: (r.author_kind ?? 'human') as AuthorKind,
  body: r.body, createdAt: r.created_at,
  verifyUrl: r.verify_url ?? null,
  verifySteps: (() => { const v = parseJson(r.verify_steps); return Array.isArray(v) ? (v as string[]) : null })(),
  evidence: r.evidence ?? null,
})
const toReport = (r: any): Report => ({
  id: r.id, shortId: shortId(r.id), projectId: r.project_id, note: r.note, screenshotUrl: r.screenshot_url, pageUrl: r.page_url,
  viewport: r.viewport, userAgent: r.user_agent, reporter: r.reporter, status: r.status, createdAt: r.created_at,
  context: parseJson(r.context), replayUrl: r.replay_url ?? null,
  videoUrl: r.video_url ?? null, videoSeconds: r.video_seconds ?? null,
  videoTrim: (parseJson(r.video_trim) as { from: number; to: number } | null) ?? null,
  videoFrames: (parseJson(r.video_frames) as { at: number; url: string }[] | null) ?? null,
  attachments: normalizeAttachments(parseJson(r.attachments)),
  type: (r.type ?? 'bug') as ReportType, severity: (r.severity ?? null) as Severity | null,
  archived: !!r.archived,
  creator: r.creator ?? null, assignee: r.assignee ?? null, takenBy: r.taken_by ?? null, takenAt: r.taken_at ?? null,
  via: r.via ?? null,
})

function parseJson(s: unknown): unknown | null {
  if (typeof s !== 'string' || !s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export type NewReport = {
  projectId: string; note: string
  screenshotUrl?: string | null; pageUrl?: string | null; viewport?: string | null
  userAgent?: string | null; reporter?: string | null; context?: unknown | null; replayUrl?: string | null
  videoUrl?: string | null; videoSeconds?: number | null; videoTrim?: { from: number; to: number } | null
  videoFrames?: { at: number; url: string }[] | null
  attachments?: Attachment[] | null
  type?: ReportType; severity?: Severity | null
  // Canonical identities (normalizeIdentity), supplied by whoever files the ticket. A capture that says nothing
  // about who filed it keeps them null — see the ingest route, which fills `creator` from the declared source.
  creator?: string | null; assignee?: string | null
  // The channel this ticket arrived through (e.g. 'extension'). Provenance only — it never affects who may act on
  // the ticket. Omitted for agent-filed tickets.
  via?: string | null
}

// ── sessions: one running process of an agent handle ──────────────────────────────────────────────────────
// A handle forks into many processes; a session is one of them. These types are what the dashboard reads to say
// "erental is 6 live sessions right now" and to flag the collision that fact represents.
export type AgentSession = {
  sessionId: string; agent: string; projectId: string | null
  origin: string; startedAt: number; lastSeen: number
}
// Live sessions collapsed to one row per handle. `count > 1` is a collision. `lastSeen` is the newest activity
// across the group, so the dashboard can sort the loudest forks to the top.
export type SessionGroup = { agent: string; count: number; lastSeen: number; sessions: AgentSession[] }

const toSession = (r: any): AgentSession => ({
  sessionId: r.session_id, agent: r.agent, projectId: r.project_id ?? null,
  origin: r.origin ?? '', startedAt: r.started_at, lastSeen: r.last_seen,
})

// ── stats aggregates: the four lenses of the stats screen, computed in SQL ─────────────────────────────────
// One row per handle for the "agent health" lens. Event-derived counts (filed…rejected) honour the optional
// window; `holding` is a CURRENT-state count (open tickets on its plate) and `lastEventAt` is the true last
// time it acted, unwindowed — both answer "is this agent overloaded / silent" regardless of the chosen window.
export type AgentActivity = {
  agent: string
  filed: number            // journal 'created' events by this actor
  taken: number            // status moves this actor made INTO 'taken'
  handedToReview: number   // status moves this actor made INTO 'needs_review'
  accepted: number         // status moves this actor made INTO 'verified' (only a filer/owner can)
  rejected: number         // status moves this actor made INTO 'rejected'
  holding: number          // reports where taken_by = this agent AND status in (taken, needs_review)
  lastEventAt: number | null
}
// One row per UTC day for the "flow over time" lens.
export type FlowDay = { day: string; created: number; verified: number }
// One stuck ticket for the "bottlenecks" lens: not resolved and addressed to nobody.
export type Orphan = { id: string; shortId: string; note: string; status: string; createdAt: number; ageMs: number }
// The "system health" lens: the counts that say whether the board itself is healthy, plus the handles behind the
// two counts a human will want to act on.
export type SystemHealth = {
  journalSize: number          // total events on the board
  unnamedActorEvents: number   // events whose actor names nobody lookup-able (extension/empty/none-like)
  liveSessions: number         // sessions seen within SESSION_LIVE_MS
  collisions: number           // handles with more than one live session
  collidingAgents: string[]    // …which handles those are
  silentAgents: number         // active roster agents not seen within SILENT_AGENT_MS
  silentAgentHandles: string[] // …which handles those are
}

// A 'status' event's detail names the destination status LAST — `${old} → ${new}` today, and older/legacy rows
// wrote it as `old -> new` or even the bare new status. Matching the destination as a SUFFIX counts a move INTO a
// status across all three spellings, and it is also the right semantics: a move is classified by where it lands,
// not where it came from. Gated by kind='status' at every call site, so a comment ending in the same word cannot
// be miscounted.
const movedIntoLike = (status: string): string => `%${status}`

export const repo = {
  getProjectByKey(key: string): Project | null {
    const r = db().prepare('SELECT * FROM projects WHERE ingest_key = ?').get(key)
    return r ? toProject(r) : null
  },
  getProjectByReadKey(key: string): Project | null {
    if (!key) return null
    const r = db().prepare('SELECT * FROM projects WHERE read_key = ?').get(key)
    return r ? toProject(r) : null
  },
  getProjectById(id: string): Project | null {
    const r = db().prepare('SELECT * FROM projects WHERE id = ?').get(id)
    return r ? toProject(r) : null
  },
  listProjects(): Project[] {
    const rows = db().prepare('SELECT * FROM projects ORDER BY created_at ASC').all()
    return rows.map(toProject)
  },
  ensureProject(name: string, ingestKey: string): Project {
    const ex = this.getProjectByKey(ingestKey)
    if (ex) return ex
    db().prepare('INSERT INTO projects (id, name, ingest_key, read_key, created_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), name, ingestKey, newReadKey(), Date.now())
    return this.getProjectByKey(ingestKey)!
  },
  // Create a fresh project bucket with generated keys: an ingest key (point the extension at it to route new
  // captures here) and a read key (hand to a dev agent for scoped read + status writes).
  createProject(name: string): Project {
    const id = crypto.randomUUID()
    const ingestKey = 'th_' + crypto.randomBytes(16).toString('hex')
    db().prepare('INSERT INTO projects (id, name, ingest_key, read_key, created_at) VALUES (?,?,?,?,?)')
      .run(id, name.trim() || 'Project', ingestKey, newReadKey(), Date.now())
    return this.getProjectById(id)!
  },
  // Reassign a report to another project bucket (human-only, from the dashboard) — this is how you scope which
  // cases an agent sees: move exactly the ones it needs into its project.
  moveReport(id: string, projectId: string): boolean {
    return db().prepare('UPDATE reports SET project_id = ? WHERE id = ?').run(projectId, id).changes > 0
  },
  // Rotate a project's agent read key: mint a fresh token and return it. The old key stops working immediately
  // (any agent using it must be updated) — use it when a key leaks.
  regenerateReadKey(projectId: string): string {
    const key = newReadKey()
    const changed = db().prepare('UPDATE projects SET read_key = ? WHERE id = ?').run(key, projectId).changes
    if (!changed) throw new Error(`regenerateReadKey: no project ${projectId}`)
    return key
  },
  createReport(x: NewReport): Report {
    const id = crypto.randomUUID()
    const attachments = normalizeAttachments(x.attachments)
    db().prepare(
      `INSERT INTO reports (id, project_id, note, screenshot_url, page_url, viewport, user_agent, reporter, status, created_at, context, replay_url, video_url, video_seconds, video_trim, video_frames, attachments, type, severity, creator, assignee, via)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, x.projectId, x.note, x.screenshotUrl ?? null, x.pageUrl ?? null, x.viewport ?? null, x.userAgent ?? null, x.reporter ?? null, STATUS_NEW, Date.now(), x.context != null ? JSON.stringify(x.context) : null, x.replayUrl ?? null, x.videoUrl ?? null, x.videoSeconds ?? null, x.videoTrim ? JSON.stringify(x.videoTrim) : null, x.videoFrames?.length ? JSON.stringify(x.videoFrames) : null, attachments.length ? JSON.stringify(attachments) : null, x.type ?? 'bug', x.severity ?? null, x.creator ?? null, x.assignee ?? null, x.via ?? null)
    return this.getReport(id)!
  },
  // Backwards compatible: the old call site passed only `status`. New filters (projectId, type) are additive
  // and AND-combined; any subset may be supplied. `archived` defaults to 0 (active only) so agents and the
  // main board never see archived tickets; pass archived:true for the archive view, or 'all' for everything.
  listReports(opts: { projectId?: string; type?: string; status?: string; assignee?: string; creator?: string; archived?: boolean | 'all'; limit?: number } = {}): Report[] {
    const lim = Math.min(opts.limit ?? 200, 1000)
    const where: string[] = []
    const args: string[] = []
    if (opts.projectId) { where.push('project_id = ?'); args.push(opts.projectId) }
    if (opts.type) { where.push('type = ?'); args.push(opts.type) }
    if (opts.status) {
      // A legacy status name can mean two lifecycle rows at once, so this is an IN, not an equality.
      const targets = statusQueryTargets(opts.status)
      where.push(`status IN (${targets.map(() => '?').join(',')})`)
      args.push(...targets)
    }
    if (opts.assignee) { where.push('assignee = ?'); args.push(opts.assignee) }
    if (opts.creator) { where.push('creator = ?'); args.push(opts.creator) }
    if (opts.archived === 'all') { /* both */ } else if (opts.archived === true) { where.push('archived = 1') } else { where.push('archived = 0') }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const rows = db().prepare(`SELECT * FROM reports${clause} ORDER BY created_at DESC LIMIT ?`).all(...args, lim)
    return rows.map(toReport)
  },
  // The two selections an agent needs to answer "what is on my plate": what was ADDRESSED to me, and what I
  // FILED (and therefore have to accept or send back). `identity` must already be canonical — see
  // normalizeIdentity; passing raw user text here would quietly match nothing.
  listAddressedTo(identity: string, opts: { projectId?: string; status?: string; archived?: boolean | 'all'; limit?: number } = {}): Report[] {
    if (!identity) return []
    return this.listReports({ ...opts, assignee: identity })
  },
  listFiledBy(identity: string, opts: { projectId?: string; status?: string; archived?: boolean | 'all'; limit?: number } = {}): Report[] {
    if (!identity) return []
    return this.listReports({ ...opts, creator: identity })
  },
  getReport(id: string): Report | null {
    const r = db().prepare('SELECT * FROM reports WHERE id = ?').get(id)
    return r ? toReport(r) : null
  },
  // Accept the SHORT id everywhere a full one works. Humans and agents refer to a ticket by its first few
  // characters (that is what fits in a sentence); resolving it here means the short form is a real identifier
  // instead of something the agent improvises. Ambiguous prefixes resolve to nothing rather than the wrong
  // ticket — being told "not found" is recoverable, acting on someone else's ticket is not.
  resolveReport(idOrShort: string): Report | null {
    const s = (idOrShort || '').trim().replace(/^#/, '').toLowerCase()
    if (!s) return null
    const exact = this.getReport(s)
    if (exact) return exact
    if (s.length < 4) return null
    const rows = db().prepare('SELECT * FROM reports WHERE id LIKE ? LIMIT 2').all(s + '%')
    return rows.length === 1 ? toReport(rows[0]) : null
  },
  // Always stores a canonical lifecycle status, whatever name the caller used. A legacy `fixed` from a client
  // written before the lifecycle means "claimed done, unchecked" → needs_review; the owner's `fixed` means
  // acceptance and is resolved to `verified` by the route, which knows who is speaking (see checkStatusTransition).
  // An unknown status throws instead of being written: a status nobody can filter on is worse than a refusal.
  setStatus(id: string, status: string): boolean {
    const canonical = canonicalStatus(status, 'agent')
    if (!canonical) throw new Error(`setStatus: unknown status "${status}" — expected one of ${STATUSES_FOR_ERROR}`)
    return db().prepare('UPDATE reports SET status = ? WHERE id = ?').run(canonical, id).changes > 0
  },
  // Who the ticket is FOR. Null clears it — a ticket can go back to being unaddressed.
  setAssignee(id: string, assignee: string | null): boolean {
    return db().prepare('UPDATE reports SET assignee = ? WHERE id = ?').run(assignee || null, id).changes > 0
  },
  // Who is HOLDING it, stamped with when. Cleared together: a holder without a time is a fact with no history,
  // and a time without a holder is noise.
  setTaken(id: string, takenBy: string | null): boolean {
    const at = takenBy ? Date.now() : null
    return db().prepare('UPDATE reports SET taken_by = ?, taken_at = ? WHERE id = ?').run(takenBy || null, at, id).changes > 0
  },
  setArchived(id: string, archived: boolean): boolean {
    return db().prepare('UPDATE reports SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id).changes > 0
  },
  // Hard delete — the UI only offers this from the archive (delete = irreversible).
  // A hard delete takes the whole ticket with it. Dropping only the `reports` row left its comments and journal
  // entries behind pointing at an id that no longer resolves: invisible in the UI, still counted by anything
  // that reads the journal, and impossible to find later precisely because the ticket they explain is gone.
  // There are no foreign keys here (sqlite without PRAGMA foreign_keys), so the cascade has to be written out.
  deleteReport(id: string): boolean {
    const c = db()
    const gone = c.prepare('DELETE FROM reports WHERE id = ?').run(id).changes > 0
    if (!gone) return false
    c.prepare('DELETE FROM comments WHERE report_id = ?').run(id)
    c.prepare('DELETE FROM events WHERE report_id = ?').run(id)
    return true
  },
  // ── change journal: what an agent polls instead of re-reading the board ───────────────────────────────
  // `session` is optional and never inferred: a caller that knows which process it is (the MCP servers, once they
  // open a session) passes it; the HTTP path and older callers omit it and the entry reads back with session=null.
  logEvent(x: { projectId: string; reportId: string; kind: EventKind; actor: string; detail?: string; session?: string | null }): number {
    const r = db().prepare('INSERT INTO events (project_id, report_id, kind, actor, detail, session, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(x.projectId, x.reportId, x.kind, x.actor, x.detail ?? null, x.session ?? null, Date.now())
    return Number(r.lastInsertRowid)
  },
  // Everything that happened in a project after `since`, oldest first. `limit` bounds a catch-up burst.
  eventsSince(projectId: string, since: number, limit = 100): ChangeEvent[] {
    const rows = db().prepare('SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(projectId, since, Math.min(limit, 500))
    return rows.map(toEvent)
  },
  /**
   * The same journal, narrowed to what concerns ONE agent. Answers the three questions an executor asks on every
   * loop: what has been addressed to me, what I filed that is now waiting for my review, and what came back to me
   * as rejected.
   *
   * `scannedTo` is the important half of the return. A filtered read still walks a whole window of the journal,
   * so acking the last MATCHING event would silently swallow everything after it inside that window. `scannedTo`
   * is the last seq actually examined — the correct thing to ack, because everything up to it has been shown or
   * deliberately excluded.
   */
  eventsSinceFor(
    projectId: string,
    since: number,
    identity: string,
    filters: UpdateFilter[],
    limit = 100,
  ): { events: ChangeEvent[]; scannedTo: number } {
    const window = Math.min(limit, 500)
    const edge = db().prepare('SELECT MAX(seq) s FROM (SELECT seq FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?)')
      .get(projectId, since, window) as { s: number | null }
    const scannedTo = edge?.s ?? since
    if (!filters.length || !identity) return { events: [], scannedTo }

    const clauses: string[] = []
    const args: (string | number)[] = [projectId, since, scannedTo]
    for (const f of filters) {
      if (f === 'inbox') { clauses.push('(r.assignee = ? AND r.status = ?)'); args.push(identity, STATUS_NEW) }
      else if (f === 'review') { clauses.push('(r.creator = ? AND r.status = ?)'); args.push(identity, STATUS_NEEDS_REVIEW) }
      else if (f === 'rework') { clauses.push('(r.status = ? AND (r.taken_by = ? OR r.assignee = ?))'); args.push(STATUS_REJECTED, identity, identity) }
    }
    const rows = db().prepare(
      `SELECT e.* FROM events e JOIN reports r ON r.id = e.report_id
       WHERE e.project_id = ? AND e.seq > ? AND e.seq <= ? AND (${clauses.join(' OR ')})
       ORDER BY e.seq ASC`,
    ).all(...args)
    return { events: rows.map(toEvent), scannedTo }
  },
  latestSeq(projectId: string): number {
    const r = db().prepare('SELECT MAX(seq) s FROM events WHERE project_id = ?').get(projectId) as { s: number | null }
    return r?.s ?? 0
  },
  /**
   * Where this reader has got to in the journal. Without `agent` it is the project position — unchanged, and
   * still what a client that never says who it is gets.
   *
   * With `agent` it is that agent's OWN position, and an agent that has never acked starts at the project
   * position rather than at zero: seeding from the board's own high-water mark means switching a running client
   * onto identities costs it no replay of history it already handled, while everything after that point stays
   * private to each agent. `identity` must already be canonical (see normalizeIdentity) — the ack writes the
   * same string back, so folding it in only one of the two places would strand the cursor under a second name.
   */
  getCursor(projectId: string, agent?: string | null): number {
    const project = db().prepare('SELECT agent_cursor c FROM projects WHERE id = ?').get(projectId) as { c: number } | undefined
    const shared = project?.c ?? 0
    if (!agent) return shared
    const own = db().prepare('SELECT cursor c FROM agent_cursors WHERE project_id = ? AND agent = ?').get(projectId, agent) as { c: number } | undefined
    return own ? own.c : shared
  },
  // Only ever moves forward: a late ack from a slow worker must not rewind past newer, already-handled events.
  setCursor(projectId: string, seq: number, agent?: string | null): number {
    const next = Math.max(this.getCursor(projectId, agent), seq)
    if (agent) {
      db().prepare('INSERT INTO agent_cursors (project_id, agent, cursor) VALUES (?,?,?) ON CONFLICT (project_id, agent) DO UPDATE SET cursor = excluded.cursor')
        .run(projectId, agent, next)
      return next
    }
    db().prepare('UPDATE projects SET agent_cursor = ? WHERE id = ?').run(next, projectId)
    return next
  },

  // ── comments: the thread on a ticket ──────────────────────────────────────────────────────────────────
  // A dev agent reports back here ("fixed in <commit>", "could not reproduce", "declined because…") and the
  // human answers in the same thread, so a ticket carries the conversation instead of just a status word.
  listComments(reportId: string): Comment[] {
    const rows = db().prepare('SELECT * FROM comments WHERE report_id = ? ORDER BY created_at ASC').all(reportId)
    return rows.map(toComment)
  },
  addComment(x: { reportId: string; author: string; authorKind: AuthorKind; body: string; verifyUrl?: string | null; verifySteps?: string[] | null; evidence?: string | null }): Comment {
    const id = crypto.randomUUID()
    const steps = x.verifySteps && x.verifySteps.length ? JSON.stringify(x.verifySteps) : null
    db().prepare('INSERT INTO comments (id, report_id, author, author_kind, body, created_at, verify_url, verify_steps, evidence) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, x.reportId, x.author, x.authorKind, x.body, Date.now(), x.verifyUrl || null, steps, x.evidence || null)
    return toComment(db().prepare('SELECT * FROM comments WHERE id = ?').get(id))
  },
  // The most recent check handed over on this ticket — what the dashboard pins at the top so the reporter never
  // has to hunt through the thread for "where do I look".
  latestVerification(reportId: string): Comment | null {
    const row = db().prepare('SELECT * FROM comments WHERE report_id = ? AND verify_url IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(reportId)
    return row ? toComment(row) : null
  },
  deleteComment(id: string): boolean {
    return db().prepare('DELETE FROM comments WHERE id = ?').run(id).changes > 0
  },
  // Кто вообще подавал голос в обсуждениях — одним запросом. Экран состава раньше выяснял это, перебирая
  // комментарии КАЖДОГО тикета: на живой доске в 380 тикетов это 380 запросов на одну загрузку страницы.
  // Ответ здесь один и тот же, а стоит он один запрос.
  commentAuthors(authorKind?: AuthorKind): { author: string; authorKind: AuthorKind; lastAt: number }[] {
    const rows = authorKind
      ? db().prepare('SELECT author, author_kind, MAX(created_at) last_at FROM comments WHERE author_kind = ? GROUP BY author, author_kind').all(authorKind)
      : db().prepare('SELECT author, author_kind, MAX(created_at) last_at FROM comments GROUP BY author, author_kind').all()
    return (rows as any[]).map((r) => ({ author: r.author, authorKind: (r.author_kind ?? 'human') as AuthorKind, lastAt: r.last_at }))
  },

  countComments(reportId: string): number {
    const r = db().prepare('SELECT COUNT(*) c FROM comments WHERE report_id = ?').get(reportId) as { c: number }
    return r?.c ?? 0
  },

  // ── the roster: who the handles in creator/assignee/taken_by/actor actually ARE ────────────────────────
  getAgent(handle: string): AgentProfile | null {
    const h = normalizeIdentity(handle)
    if (!h) return null
    const r = db().prepare('SELECT * FROM agents WHERE handle = ?').get(h)
    return r ? toAgent(r) : null
  },
  /**
   * Create or describe one agent. Only the supplied fields are written, so an agent registering itself for the
   * hundredth time cannot blank the role the owner wrote for it by simply not repeating it.
   *
   * `handle` must be a real identity — a roster row under an empty name would be a directory entry nobody can
   * address, so this throws rather than inventing one.
   *
   * Describing an agent does NOT move `last_seen`: that column answers "when did this one last ACT", and the owner
   * writing a role for an agent that went silent a month ago must not make it look alive again. Only touchAgent
   * moves it.
   */
  upsertAgent(x: { handle: string; title?: string | null; role?: string | null; active?: boolean; board?: string | null }): AgentProfile {
    const handle = normalizeIdentity(x.handle)
    if (!handle) throw new Error(`upsertAgent: "${String(x.handle)}" is not a usable identity — expected a short handle like "mcp-core"`)
    const now = Date.now()
    const before = this.getAgent(handle)
    const boards = mergeBoards(before?.boards ?? [], x.board)
    const title = x.title !== undefined ? (normalizeAgentTitle(x.title) ?? '') : (before?.title ?? '')
    const role = x.role !== undefined ? (normalizeAgentRole(x.role) ?? '') : (before?.role ?? '')
    const active = x.active !== undefined ? x.active : (before?.active ?? true)
    if (!before) {
      db().prepare('INSERT INTO agents (handle, title, role, boards, first_seen, last_seen, active) VALUES (?,?,?,?,?,?,?)')
        .run(handle, title, role, JSON.stringify(boards), now, now, active ? 1 : 0)
    } else {
      db().prepare('UPDATE agents SET title = ?, role = ?, boards = ?, active = ? WHERE handle = ?')
        .run(title, role, JSON.stringify(boards), active ? 1 : 0, handle)
    }
    return this.getAgent(handle)!
  },
  /**
   * Record that this agent just acted, and on which board. Runs on every identified write, so it stays one indexed
   * lookup and one UPDATE — the boards column is only rewritten when the board is genuinely new to that agent.
   *
   * An unregistered handle is created here: that is self-registration, and it is deliberately the ONLY way a row
   * appears without anyone describing it. The caller decides whether a handle has earned that — see resolveSpeaker,
   * which returns null for an identity nobody declared.
   */
  touchAgent(handle: string, board?: string | null): void {
    const h = normalizeIdentity(handle)
    if (!h) throw new Error(`touchAgent: "${String(handle)}" is not a usable identity — callers must pass a canonical handle`)
    const row = db().prepare('SELECT boards FROM agents WHERE handle = ?').get(h) as { boards: string } | undefined
    if (!row) {
      this.upsertAgent({ handle: h, board })
      return
    }
    const boards = parseBoards(row.boards)
    if (board && !boards.includes(board)) {
      db().prepare('UPDATE agents SET last_seen = ?, boards = ? WHERE handle = ?').run(Date.now(), JSON.stringify([...boards, board]), h)
      return
    }
    db().prepare('UPDATE agents SET last_seen = ? WHERE handle = ?').run(Date.now(), h)
  },
  /**
   * The whole roster, most recently active first — the answer to "who is here and what do they do". `board`
   * filters in memory on purpose: the roster is a handful of rows always read whole, and a join table would be a
   * second schema to migrate for a set that is never queried on its own.
   */
  listAgents(opts: { activeOnly?: boolean; board?: string } = {}): AgentProfile[] {
    const rows = db().prepare('SELECT * FROM agents ORDER BY last_seen DESC').all().map(toAgent)
    return rows.filter((a) => (opts.activeOnly ? a.active : true) && (opts.board ? a.boards.includes(opts.board) : true))
  },
  /**
   * The roster rows for a specific set of handles — who the participants of these tickets are. Handles with no row
   * are simply absent from the answer; the caller reports that gap explicitly rather than inventing a profile for
   * a name nobody claimed.
   */
  getAgents(handles: string[]): AgentProfile[] {
    const wanted = [...new Set(handles.map((h) => normalizeIdentity(h)).filter((h): h is string => !!h))]
    if (!wanted.length) return []
    const rows = db().prepare(`SELECT * FROM agents WHERE handle IN (${wanted.map(() => '?').join(',')})`).all(...wanted)
    return rows.map(toAgent)
  },

  // Edit a report's properties after creation. Only the supplied fields are written.
  // `attachments` replaces the whole list (it is one ordered value, not a bag to append to) and is capped and
  // re-validated here; an empty list clears the column.
  updateReport(id: string, fields: { note?: string; type?: ReportType; severity?: Severity | null; attachments?: Attachment[] }): boolean {
    const sets: string[] = []
    const args: (string | null)[] = []
    if (fields.note !== undefined) { sets.push('note = ?'); args.push(fields.note) }
    if (fields.type !== undefined) { sets.push('type = ?'); args.push(fields.type) }
    if (fields.severity !== undefined) { sets.push('severity = ?'); args.push(fields.severity) }
    if (fields.attachments !== undefined) {
      const list = normalizeAttachments(fields.attachments)
      sets.push('attachments = ?')
      args.push(list.length ? JSON.stringify(list) : null)
    }
    if (!sets.length) return false
    args.push(id)
    return db().prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...args).changes > 0
  },

  // ── sessions: which running processes an agent handle has forked into ──────────────────────────────────
  /**
   * Announce a session, or refresh one that already exists. `started_at` is written ONCE — a process that opens
   * its session a second time (a reconnect) keeps its original start time, and only `last_seen` moves; `origin`
   * is refreshed only when a non-empty one is supplied, so a later call cannot blank provenance the first set.
   * `agent` must already be canonical (normalizeIdentity), as the stored handle everywhere else is — grouping
   * live sessions per handle is a plain equality, and raw casing would split one agent into several.
   */
  openSession(x: { sessionId: string; agent: string; projectId?: string | null; origin?: string; startedAt: number }): void {
    const agent = normalizeIdentity(x.agent)
    if (!agent) throw new Error(`openSession: "${String(x.agent)}" is not a usable agent handle`)
    if (!x.sessionId) throw new Error('openSession: sessionId is required — a session with no id cannot be tracked')
    const now = Date.now()
    db().prepare(
      `INSERT INTO agent_sessions (session_id, agent, project_id, origin, started_at, last_seen)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         project_id = COALESCE(excluded.project_id, agent_sessions.project_id),
         origin = CASE WHEN excluded.origin != '' THEN excluded.origin ELSE agent_sessions.origin END`,
    ).run(x.sessionId, agent, x.projectId ?? null, x.origin ?? '', x.startedAt, now)
  },
  /**
   * Move a session's last_seen to now — the cheap heartbeat run on every call. Returns whether a row was found:
   * a session that was never opened has nothing to move, and the caller (not a silent fallback here) decides
   * whether to open one. No auto-create: touchSession does not know the agent/origin an open needs.
   */
  touchSession(sessionId: string): boolean {
    if (!sessionId) return false
    return db().prepare('UPDATE agent_sessions SET last_seen = ? WHERE session_id = ?').run(Date.now(), sessionId).changes > 0
  },
  /** The live sessions for one handle, newest activity first. `windowMs` defaults to SESSION_LIVE_MS. */
  liveSessions(agent: string, windowMs: number = SESSION_LIVE_MS): AgentSession[] {
    const h = normalizeIdentity(agent)
    if (!h) return []
    const cutoff = Date.now() - windowMs
    const rows = db().prepare('SELECT * FROM agent_sessions WHERE agent = ? AND last_seen >= ? ORDER BY last_seen DESC').all(h, cutoff)
    return rows.map(toSession)
  },
  /**
   * Every live session, collapsed to one row per handle — the dashboard's collision view. A group with count > 1
   * is an agent whose handle is being signed by more than one running process at once. `windowMs` defaults to
   * SESSION_LIVE_MS; groups are ordered by newest activity, and sessions within a group likewise.
   */
  sessionsByAgent(windowMs: number = SESSION_LIVE_MS): SessionGroup[] {
    const cutoff = Date.now() - windowMs
    // The live set is bounded by the window (minutes), so it is small — grouping the already-ordered rows in JS
    // keeps "newest first" exact without a second query. This is not the 1000-row scan the stats reads avoid.
    const rows = db().prepare('SELECT * FROM agent_sessions WHERE last_seen >= ? ORDER BY last_seen DESC').all(cutoff).map(toSession)
    const groups = new Map<string, SessionGroup>()
    for (const s of rows) {
      const g = groups.get(s.agent)
      if (g) { g.sessions.push(s); g.count++; if (s.lastSeen > g.lastSeen) g.lastSeen = s.lastSeen }
      else groups.set(s.agent, { agent: s.agent, count: 1, lastSeen: s.lastSeen, sessions: [s] })
    }
    return [...groups.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  },

  // ── stats aggregates: pure reads for the stats screen, counted in SQL ──────────────────────────────────
  /**
   * The "agent health" lens: one row per handle that has either acted in the journal or is currently holding a
   * ticket. The five action counts are windowed when `windowMs` is given (the last N ms); `holding` and
   * `lastEventAt` are always current/all-time — you flag a silent agent by how long ago it last acted, not by a
   * window that would hide the silence. Counting is GROUP BY in SQLite; only the merge of the few handles is JS.
   */
  agentActivity(windowMs?: number): AgentActivity[] {
    const c = db()
    // undefined means all-time; a number (including 0) is a real cutoff, so 0 does not silently become all-time.
    const since = windowMs === undefined ? 0 : Date.now() - windowMs
    const acc = new Map<string, AgentActivity>()
    const row = (agent: string): AgentActivity => {
      let r = acc.get(agent)
      if (!r) { r = { agent, filed: 0, taken: 0, handedToReview: 0, accepted: 0, rejected: 0, holding: 0, lastEventAt: null }; acc.set(agent, r) }
      return r
    }
    const counts = c.prepare(
      `SELECT actor,
         SUM(CASE WHEN kind = 'created' THEN 1 ELSE 0 END) AS filed,
         SUM(CASE WHEN kind = 'status' AND detail LIKE ? THEN 1 ELSE 0 END) AS taken,
         SUM(CASE WHEN kind = 'status' AND detail LIKE ? THEN 1 ELSE 0 END) AS handed,
         SUM(CASE WHEN kind = 'status' AND detail LIKE ? THEN 1 ELSE 0 END) AS accepted,
         SUM(CASE WHEN kind = 'status' AND detail LIKE ? THEN 1 ELSE 0 END) AS rejected
       FROM events WHERE created_at >= ? GROUP BY actor`,
    ).all(movedIntoLike(STATUS_TAKEN), movedIntoLike(STATUS_NEEDS_REVIEW), movedIntoLike(STATUS_VERIFIED), movedIntoLike(STATUS_REJECTED), since) as any[]
    for (const r of counts) {
      const a = row(r.actor)
      a.filed = Number(r.filed); a.taken = Number(r.taken); a.handedToReview = Number(r.handed)
      a.accepted = Number(r.accepted); a.rejected = Number(r.rejected)
    }
    // Last time each actor acted — the true maximum, never windowed, so silence is measurable.
    const last = c.prepare('SELECT actor, MAX(created_at) AS last_at FROM events GROUP BY actor').all() as any[]
    for (const r of last) row(r.actor).lastEventAt = r.last_at
    // Open tickets on each agent's plate right now: held by it and not yet resolved or handed back.
    const holding = c.prepare(
      'SELECT taken_by AS agent, COUNT(*) AS n FROM reports WHERE taken_by IS NOT NULL AND status IN (?, ?) GROUP BY taken_by',
    ).all(STATUS_TAKEN, STATUS_NEEDS_REVIEW) as any[]
    for (const r of holding) row(r.agent).holding = Number(r.n)
    return [...acc.values()].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))
  },
  /**
   * The "flow over time" lens: filed vs accepted per UTC day over the last `days` days. Buckets are UTC
   * (date(created_at/1000,'unixepoch')) so the same event lands in the same bucket wherever it is read from.
   * Only days that saw activity appear — the screen fills the gaps, which it must do anyway for a continuous axis.
   */
  flowByDay(days: number): FlowDay[] {
    const since = Date.now() - Math.max(1, days) * DAY_MS
    const rows = db().prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
         SUM(CASE WHEN kind = 'created' THEN 1 ELSE 0 END) AS created,
         SUM(CASE WHEN kind = 'status' AND detail LIKE ? THEN 1 ELSE 0 END) AS verified
       FROM events WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
    ).all(movedIntoLike(STATUS_VERIFIED), since) as any[]
    return rows.map((r) => ({ day: r.day as string, created: Number(r.created), verified: Number(r.verified) }))
  },
  /**
   * The "bottlenecks" lens: the stuck pile — tickets nobody is addressed to that are not yet resolved. `verified`
   * and `wontfix` are excluded (both are settled outcomes, not stuck work) and archived rows are excluded (they
   * are hidden everywhere else on the board — surfacing them only here would mislead). Oldest first: the top of
   * this list is the ticket that has waited longest. `ageMs` is a derived scalar off created_at.
   */
  orphans(): Orphan[] {
    const now = Date.now()
    const rows = db().prepare(
      `SELECT id, note, status, created_at FROM reports
       WHERE assignee IS NULL AND archived = 0 AND status NOT IN (?, ?)
       ORDER BY created_at ASC`,
    ).all(STATUS_VERIFIED, STATUS_WONTFIX) as any[]
    return rows.map((r) => ({ id: r.id, shortId: shortId(r.id), note: r.note, status: r.status, createdAt: r.created_at, ageMs: now - r.created_at }))
  },
  /**
   * The "system health" lens: is the board itself healthy. Journal size and the count of events whose actor names
   * nobody lookup-able (the extension channel, an empty string, a None-like literal) both measure signal quality;
   * collisions come from the live-session view; silent agents are active roster rows that have gone quiet past
   * SILENT_AGENT_MS. The handles behind the last two counts ride along so the screen can name them.
   */
  systemHealth(): SystemHealth {
    const c = db()
    const journalSize = (c.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const unnamedPlaceholders = UNNAMED_ACTORS.map(() => '?').join(',')
    const unnamedActorEvents = (c.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE actor IS NULL OR LOWER(actor) IN (${unnamedPlaceholders})`,
    ).get(...UNNAMED_ACTORS) as { n: number }).n
    const groups = this.sessionsByAgent()
    const colliding = groups.filter((g) => g.count > 1)
    const liveSessions = groups.reduce((n, g) => n + g.count, 0)
    const silentCutoff = Date.now() - SILENT_AGENT_MS
    const silent = this.listAgents({ activeOnly: true }).filter((a) => a.lastSeen < silentCutoff)
    return {
      journalSize,
      unnamedActorEvents,
      liveSessions,
      collisions: colliding.length,
      collidingAgents: colliding.map((g) => g.agent),
      silentAgents: silent.length,
      silentAgentHandles: silent.map((a) => a.handle),
    }
  },
}

// Tables are created at module load; kept for a stable call-site the apps can await.
export function ensureSchema(): Promise<void> {
  return Promise.resolve()
}
