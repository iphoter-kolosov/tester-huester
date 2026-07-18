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

// Cache the handle across Next's dev hot-reload.
const g = globalThis as unknown as { __thsqlite?: DatabaseSync }
const conn: DatabaseSync = g.__thsqlite ?? (g.__thsqlite = new DatabaseSync(file))

conn.exec(`
  PRAGMA journal_mode = WAL;
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
    context text
  );
`)

// Idempotent migration for DBs created before the `context` column existed (e.g. the demo th.db).
if (!columnExists(conn, 'reports', 'context')) {
  conn.exec('ALTER TABLE reports ADD COLUMN context text')
}

function columnExists(c: DatabaseSync, table: string, column: string): boolean {
  const rows = c.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

export type Project = { id: string; name: string; ingestKey: string; createdAt: number }
// `context` is the repro bundle (env/console/network/actions from @th/core), stored as JSON. Typed as
// unknown here to keep @th/db dependency-free; consumers cast it to ReproBundle.
export type Report = {
  id: string; projectId: string; note: string; screenshotUrl: string | null; pageUrl: string | null
  viewport: string | null; userAgent: string | null; reporter: string | null; status: string; createdAt: number
  context: unknown | null
}

const toProject = (r: any): Project => ({ id: r.id, name: r.name, ingestKey: r.ingest_key, createdAt: r.created_at })
const toReport = (r: any): Report => ({
  id: r.id, projectId: r.project_id, note: r.note, screenshotUrl: r.screenshot_url, pageUrl: r.page_url,
  viewport: r.viewport, userAgent: r.user_agent, reporter: r.reporter, status: r.status, createdAt: r.created_at,
  context: parseJson(r.context),
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
  userAgent?: string | null; reporter?: string | null; context?: unknown | null
}

export const repo = {
  getProjectByKey(key: string): Project | null {
    const r = conn.prepare('SELECT * FROM projects WHERE ingest_key = ?').get(key)
    return r ? toProject(r) : null
  },
  ensureProject(name: string, ingestKey: string): Project {
    const ex = this.getProjectByKey(ingestKey)
    if (ex) return ex
    conn.prepare('INSERT INTO projects (id, name, ingest_key, created_at) VALUES (?,?,?,?)')
      .run(crypto.randomUUID(), name, ingestKey, Date.now())
    return this.getProjectByKey(ingestKey)!
  },
  createReport(x: NewReport): Report {
    const id = crypto.randomUUID()
    conn.prepare(
      `INSERT INTO reports (id, project_id, note, screenshot_url, page_url, viewport, user_agent, reporter, status, created_at, context)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, x.projectId, x.note, x.screenshotUrl ?? null, x.pageUrl ?? null, x.viewport ?? null, x.userAgent ?? null, x.reporter ?? null, 'new', Date.now(), x.context != null ? JSON.stringify(x.context) : null)
    return this.getReport(id)!
  },
  listReports(opts: { status?: string; limit?: number } = {}): Report[] {
    const lim = Math.min(opts.limit ?? 200, 500)
    const rows = opts.status
      ? conn.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(opts.status, lim)
      : conn.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(lim)
    return rows.map(toReport)
  },
  getReport(id: string): Report | null {
    const r = conn.prepare('SELECT * FROM reports WHERE id = ?').get(id)
    return r ? toReport(r) : null
  },
  setStatus(id: string, status: string): boolean {
    return conn.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id).changes > 0
  },
}

// Tables are created at module load; kept for a stable call-site the apps can await.
export function ensureSchema(): Promise<void> {
  return Promise.resolve()
}
