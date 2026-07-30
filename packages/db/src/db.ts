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
  // Per-project read key: read-only, single-project scope for an agent (REST/MCP) — no dashboard cookie, no
  // write-capable ingest key. Added nullable, then backfilled for pre-existing projects.
  if (!columnExists(c, 'projects', 'read_key')) c.exec('ALTER TABLE projects ADD COLUMN read_key text')
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
export type Report = {
  id: string; projectId: string; note: string; screenshotUrl: string | null; pageUrl: string | null
  viewport: string | null; userAgent: string | null; reporter: string | null; status: string; createdAt: number
  context: unknown | null; replayUrl: string | null; type: ReportType; severity: Severity | null; archived: boolean
}

export type AuthorKind = 'agent' | 'human'
export type Comment = { id: string; reportId: string; author: string; authorKind: AuthorKind; body: string; createdAt: number }

const toProject = (r: any): Project => ({ id: r.id, name: r.name, ingestKey: r.ingest_key, readKey: r.read_key ?? '', createdAt: r.created_at })
const toComment = (r: any): Comment => ({ id: r.id, reportId: r.report_id, author: r.author, authorKind: (r.author_kind ?? 'human') as AuthorKind, body: r.body, createdAt: r.created_at })
const toReport = (r: any): Report => ({
  id: r.id, projectId: r.project_id, note: r.note, screenshotUrl: r.screenshot_url, pageUrl: r.page_url,
  viewport: r.viewport, userAgent: r.user_agent, reporter: r.reporter, status: r.status, createdAt: r.created_at,
  context: parseJson(r.context), replayUrl: r.replay_url ?? null,
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
    db().prepare(
      `INSERT INTO reports (id, project_id, note, screenshot_url, page_url, viewport, user_agent, reporter, status, created_at, context, replay_url, type, severity)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, x.projectId, x.note, x.screenshotUrl ?? null, x.pageUrl ?? null, x.viewport ?? null, x.userAgent ?? null, x.reporter ?? null, 'new', Date.now(), x.context != null ? JSON.stringify(x.context) : null, x.replayUrl ?? null, x.type ?? 'bug', x.severity ?? null)
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
  // ── comments: the thread on a ticket ──────────────────────────────────────────────────────────────────
  // A dev agent reports back here ("fixed in <commit>", "could not reproduce", "declined because…") and the
  // human answers in the same thread, so a ticket carries the conversation instead of just a status word.
  listComments(reportId: string): Comment[] {
    const rows = db().prepare('SELECT * FROM comments WHERE report_id = ? ORDER BY created_at ASC').all(reportId)
    return rows.map(toComment)
  },
  addComment(x: { reportId: string; author: string; authorKind: AuthorKind; body: string }): Comment {
    const id = crypto.randomUUID()
    db().prepare('INSERT INTO comments (id, report_id, author, author_kind, body, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, x.reportId, x.author, x.authorKind, x.body, Date.now())
    return toComment(db().prepare('SELECT * FROM comments WHERE id = ?').get(id))
  },
  deleteComment(id: string): boolean {
    return db().prepare('DELETE FROM comments WHERE id = ?').run(id).changes > 0
  },
  countComments(reportId: string): number {
    const r = db().prepare('SELECT COUNT(*) c FROM comments WHERE report_id = ?').get(reportId) as { c: number }
    return r?.c ?? 0
  },

  // Edit a report's properties after creation. Only the supplied fields are written.
  updateReport(id: string, fields: { note?: string; type?: ReportType; severity?: Severity | null }): boolean {
    const sets: string[] = []
    const args: (string | null)[] = []
    if (fields.note !== undefined) { sets.push('note = ?'); args.push(fields.note) }
    if (fields.type !== undefined) { sets.push('type = ?'); args.push(fields.type) }
    if (fields.severity !== undefined) { sets.push('severity = ?'); args.push(fields.severity) }
    if (!sets.length) return false
    args.push(id)
    return db().prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...args).changes > 0
  },
}

// Tables are created at module load; kept for a stable call-site the apps can await.
export function ensureSchema(): Promise<void> {
  return Promise.resolve()
}
