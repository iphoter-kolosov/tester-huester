import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

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
    -- Change journal. An agent asks "what happened since cursor X" instead of re-reading every ticket to
    -- discover state — one cheap call, and the row itself says what changed and who changed it.
    CREATE TABLE IF NOT EXISTS events (
      seq integer PRIMARY KEY AUTOINCREMENT,   -- monotonic cursor
      project_id text NOT NULL,
      report_id text NOT NULL,
      kind text NOT NULL,                      -- created | status | edited | comment | archived | moved
      actor text NOT NULL,                     -- 'human' | agent/project name | 'extension'
      detail text,                             -- e.g. 'new -> fixed', or the comment's first line
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_project_idx ON events (project_id, seq);
    CREATE TABLE IF NOT EXISTS comments (
      id text PRIMARY KEY,
      report_id text NOT NULL,
      author text NOT NULL,        -- display name: the project's name for an agent, 'Вы' for the dashboard
      author_kind text NOT NULL,   -- 'agent' | 'human'
      body text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_report_idx ON comments (report_id, created_at);
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
  backfillReadKeys(c)
  return c
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

export type EventKind = 'created' | 'status' | 'edited' | 'comment' | 'archived' | 'moved'
export type ChangeEvent = { seq: number; projectId: string; reportId: string; kind: EventKind; actor: string; detail: string | null; createdAt: number }
const toEvent = (r: any): ChangeEvent => ({ seq: r.seq, projectId: r.project_id, reportId: r.report_id, kind: r.kind as EventKind, actor: r.actor, detail: r.detail ?? null, createdAt: r.created_at })

export type AuthorKind = 'agent' | 'human'
// `verifyUrl` / `verifySteps` are the check the author is handing over: WHERE to look and HOW. Required of an
// agent claiming 'fixed' (enforced at the API layer), optional on any other comment.
export type Comment = {
  id: string; reportId: string; author: string; authorKind: AuthorKind; body: string; createdAt: number
  verifyUrl: string | null; verifySteps: string[] | null
}

const toProject = (r: any): Project => ({ id: r.id, name: r.name, ingestKey: r.ingest_key, readKey: r.read_key ?? '', createdAt: r.created_at })
const toComment = (r: any): Comment => ({
  id: r.id, reportId: r.report_id, author: r.author, authorKind: (r.author_kind ?? 'human') as AuthorKind,
  body: r.body, createdAt: r.created_at,
  verifyUrl: r.verify_url ?? null,
  verifySteps: (() => { const v = parseJson(r.verify_steps); return Array.isArray(v) ? (v as string[]) : null })(),
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
}

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
      `INSERT INTO reports (id, project_id, note, screenshot_url, page_url, viewport, user_agent, reporter, status, created_at, context, replay_url, video_url, video_seconds, video_trim, video_frames, attachments, type, severity)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, x.projectId, x.note, x.screenshotUrl ?? null, x.pageUrl ?? null, x.viewport ?? null, x.userAgent ?? null, x.reporter ?? null, 'new', Date.now(), x.context != null ? JSON.stringify(x.context) : null, x.replayUrl ?? null, x.videoUrl ?? null, x.videoSeconds ?? null, x.videoTrim ? JSON.stringify(x.videoTrim) : null, x.videoFrames?.length ? JSON.stringify(x.videoFrames) : null, attachments.length ? JSON.stringify(attachments) : null, x.type ?? 'bug', x.severity ?? null)
    return this.getReport(id)!
  },
  // Backwards compatible: the old call site passed only `status`. New filters (projectId, type) are additive
  // and AND-combined; any subset may be supplied. `archived` defaults to 0 (active only) so agents and the
  // main board never see archived tickets; pass archived:true for the archive view, or 'all' for everything.
  listReports(opts: { projectId?: string; type?: string; status?: string; archived?: boolean | 'all'; limit?: number } = {}): Report[] {
    const lim = Math.min(opts.limit ?? 200, 1000)
    const where: string[] = []
    const args: string[] = []
    if (opts.projectId) { where.push('project_id = ?'); args.push(opts.projectId) }
    if (opts.type) { where.push('type = ?'); args.push(opts.type) }
    if (opts.status) { where.push('status = ?'); args.push(opts.status) }
    if (opts.archived === 'all') { /* both */ } else if (opts.archived === true) { where.push('archived = 1') } else { where.push('archived = 0') }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const rows = db().prepare(`SELECT * FROM reports${clause} ORDER BY created_at DESC LIMIT ?`).all(...args, lim)
    return rows.map(toReport)
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
  setStatus(id: string, status: string): boolean {
    return db().prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id).changes > 0
  },
  setArchived(id: string, archived: boolean): boolean {
    return db().prepare('UPDATE reports SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id).changes > 0
  },
  // Hard delete — the UI only offers this from the archive (delete = irreversible).
  deleteReport(id: string): boolean {
    return db().prepare('DELETE FROM reports WHERE id = ?').run(id).changes > 0
  },
  // ── change journal: what an agent polls instead of re-reading the board ───────────────────────────────
  logEvent(x: { projectId: string; reportId: string; kind: EventKind; actor: string; detail?: string }): number {
    const r = db().prepare('INSERT INTO events (project_id, report_id, kind, actor, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(x.projectId, x.reportId, x.kind, x.actor, x.detail ?? null, Date.now())
    return Number(r.lastInsertRowid)
  },
  // Everything that happened in a project after `since`, oldest first. `limit` bounds a catch-up burst.
  eventsSince(projectId: string, since: number, limit = 100): ChangeEvent[] {
    const rows = db().prepare('SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(projectId, since, Math.min(limit, 500))
    return rows.map(toEvent)
  },
  latestSeq(projectId: string): number {
    const r = db().prepare('SELECT MAX(seq) s FROM events WHERE project_id = ?').get(projectId) as { s: number | null }
    return r?.s ?? 0
  },
  getCursor(projectId: string): number {
    const r = db().prepare('SELECT agent_cursor c FROM projects WHERE id = ?').get(projectId) as { c: number } | undefined
    return r?.c ?? 0
  },
  // Only ever moves forward: a late ack from a slow worker must not rewind past newer, already-handled events.
  setCursor(projectId: string, seq: number): number {
    const cur = this.getCursor(projectId)
    const next = Math.max(cur, seq)
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
  addComment(x: { reportId: string; author: string; authorKind: AuthorKind; body: string; verifyUrl?: string | null; verifySteps?: string[] | null }): Comment {
    const id = crypto.randomUUID()
    const steps = x.verifySteps && x.verifySteps.length ? JSON.stringify(x.verifySteps) : null
    db().prepare('INSERT INTO comments (id, report_id, author, author_kind, body, created_at, verify_url, verify_steps) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, x.reportId, x.author, x.authorKind, x.body, Date.now(), x.verifyUrl || null, steps)
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
  countComments(reportId: string): number {
    const r = db().prepare('SELECT COUNT(*) c FROM comments WHERE report_id = ?').get(reportId) as { c: number }
    return r?.c ?? 0
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
}

// Tables are created at module load; kept for a stable call-site the apps can await.
export function ensureSchema(): Promise<void> {
  return Promise.resolve()
}
