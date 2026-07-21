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
  context: unknown | null; replayUrl: string | null; type: ReportType; severity: Severity | null
}

const toProject = (r: any): Project => ({ id: r.id, name: r.name, ingestKey: r.ingest_key, readKey: r.read_key ?? '', createdAt: r.created_at })
const toReport = (r: any): Report => ({
  id: r.id, projectId: r.project_id, note: r.note, screenshotUrl: r.screenshot_url, pageUrl: r.page_url,
  viewport: r.viewport, userAgent: r.user_agent, reporter: r.reporter, status: r.status, createdAt: r.created_at,
  context: parseJson(r.context), replayUrl: r.replay_url ?? null,
  type: (r.type ?? 'bug') as ReportType, severity: (r.severity ?? null) as Severity | null,
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
  createReport(x: NewReport): Report {
    const id = crypto.randomUUID()
    db().prepare(
      `INSERT INTO reports (id, project_id, note, screenshot_url, page_url, viewport, user_agent, reporter, status, created_at, context, replay_url, type, severity)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, x.projectId, x.note, x.screenshotUrl ?? null, x.pageUrl ?? null, x.viewport ?? null, x.userAgent ?? null, x.reporter ?? null, 'new', Date.now(), x.context != null ? JSON.stringify(x.context) : null, x.replayUrl ?? null, x.type ?? 'bug', x.severity ?? null)
    return this.getReport(id)!
  },
  // Backwards compatible: the old call site passed only `status`. New filters (projectId, type) are additive
  // and AND-combined; any subset may be supplied.
  listReports(opts: { projectId?: string; type?: string; status?: string; limit?: number } = {}): Report[] {
    const lim = Math.min(opts.limit ?? 200, 500)
    const where: string[] = []
    const args: string[] = []
    if (opts.projectId) { where.push('project_id = ?'); args.push(opts.projectId) }
    if (opts.type) { where.push('type = ?'); args.push(opts.type) }
    if (opts.status) { where.push('status = ?'); args.push(opts.status) }
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
}

// Tables are created at module load; kept for a stable call-site the apps can await.
export function ensureSchema(): Promise<void> {
  return Promise.resolve()
}
