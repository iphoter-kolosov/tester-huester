// The roster against a REAL database file, because the two things that can go wrong here cannot be reasoned
// about from the types: whether the schema lands on a database that already has rows (the live one has ~370
// tickets), and whether the owner's two journal names actually collapse into one.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IDENTITY_EXTENSION, IDENTITY_OWNER, LEGACY_ACTOR_HUMAN } from './verify.ts'

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-roster-')), 'th.db')

// A database as it exists in production BEFORE this change: tickets, a journal that spells the owner two ways,
// and no agents table. Written directly, so the migration is exercised rather than the happy path.
const seed = new DatabaseSync(file)
seed.exec(`
  CREATE TABLE projects (id text PRIMARY KEY, name text NOT NULL, ingest_key text NOT NULL UNIQUE, created_at integer NOT NULL);
  CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
  CREATE TABLE events (
    seq integer PRIMARY KEY AUTOINCREMENT, project_id text NOT NULL, report_id text NOT NULL,
    kind text NOT NULL, actor text NOT NULL, detail text, created_at integer NOT NULL
  );
  INSERT INTO projects (id, name, ingest_key, created_at) VALUES ('p1', 'photoking agents', 'th_seed', 1);
  INSERT INTO events (project_id, report_id, kind, actor, detail, created_at) VALUES
    ('p1','r1','status','human','new -> fixed',1),
    ('p1','r2','comment','human','посмотри',2),
    ('p1','r3','status','owner','new -> verified',3),
    ('p1','r4','status','mcp-core','taken',4);
`)
seed.close()

process.env.SQLITE_FILE = file
const { repo } = await import('./db.ts')

let passed = 0
function t(name: string, fn: () => void) {
  fn()
  passed++
  void name
}

t('the roster appears on a database that already has data, seeded with the two standing participants', () => {
  const seeded = repo.listAgents().map((a) => a.handle).sort()
  assert.deepEqual(seeded, [IDENTITY_EXTENSION, IDENTITY_OWNER].sort())
  const owner = repo.getAgent(IDENTITY_OWNER)!
  assert.ok(owner.role.length > 40, 'the owner is described like anyone else, not left as a bare handle')
  assert.equal(repo.getAgent(IDENTITY_EXTENSION)!.active, false, 'the capture channel is not offered as an assignee')
})

t('the owner has ONE name in the journal afterwards — the old rows read as the owner', () => {
  const rows = repo.eventsSince('p1', 0, 100)
  assert.equal(rows.filter((e) => e.actor === LEGACY_ACTOR_HUMAN).length, 0)
  assert.equal(rows.filter((e) => e.actor === IDENTITY_OWNER).length, 3, 'two rewritten plus the one already correct')
  assert.equal(rows.filter((e) => e.actor === 'mcp-core').length, 1, 'nothing else was touched')
})

/** Force the next repo call to re-open the database, which is what re-runs the whole schema path. */
function reopen(): void {
  const g = globalThis as { __thsqlite?: { close(): void } }
  g.__thsqlite?.close()
  g.__thsqlite = undefined
}

t('re-opening the database re-runs the schema harmlessly — it must survive every restart', () => {
  repo.upsertAgent({ handle: IDENTITY_OWNER, title: 'Ihor' }) // the owner renamed his own row
  reopen()
  assert.equal(repo.getAgent(IDENTITY_OWNER)!.title, 'Ihor', 'the seed must not overwrite an edited row')
  assert.equal(repo.listAgents().length, 2, 'and must not insert a second copy')
})

t('the unification is recorded, so it cannot run twice over rows that mean something else by then', () => {
  // A row written as 'human' AFTER the pass must survive untouched: the meta guard is what makes that true, and
  // without it a restart would keep promoting whatever that name comes to mean next.
  const c = new DatabaseSync(file)
  c.prepare('INSERT INTO events (project_id, report_id, kind, actor, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run('p1', 'r5', 'status', LEGACY_ACTOR_HUMAN, 'a later row', 5)
  c.close()
  reopen()
  assert.equal(repo.eventsSince('p1', 0, 100).filter((e) => e.actor === LEGACY_ACTOR_HUMAN).length, 1)
})

t('an agent registers itself by acting, with no title and no role until it says otherwise', () => {
  repo.touchAgent('mcp-core', 'p1')
  const a = repo.getAgent('mcp-core')!
  assert.equal(a.title, '')
  assert.equal(a.role, '')
  assert.equal(a.active, true)
  assert.deepEqual(a.boards, ['p1'])
  assert.equal(a.firstSeen, a.lastSeen)
})

t('describing an agent writes only what was sent, and does not resurrect a dead one', () => {
  const before = repo.getAgent('mcp-core')!
  repo.upsertAgent({ handle: 'mcp-core', title: 'MCP-ядро', role: 'Держит контракт MCP и схему базы.' })
  repo.upsertAgent({ handle: 'mcp-core', active: true }) // says nothing about the text
  const after = repo.getAgent('mcp-core')!
  assert.equal(after.title, 'MCP-ядро')
  assert.equal(after.role, 'Держит контракт MCP и схему базы.')
  assert.equal(after.lastSeen, before.lastSeen, 'writing ABOUT an agent is not the agent acting')
})

t('acting again moves last_seen and adds the new board without losing the old one', () => {
  const before = repo.getAgent('mcp-core')!
  repo.touchAgent('MCP-Core', 'p2') // the caller may hand it any casing; the handle is one row
  const after = repo.getAgent('mcp-core')!
  assert.deepEqual(after.boards, ['p1', 'p2'])
  assert.ok(after.lastSeen >= before.lastSeen)
  assert.equal(repo.listAgents({ board: 'p2' }).map((a) => a.handle).join(), 'mcp-core')
})

t('a retired agent stays on the roster and drops out of the assignable list', () => {
  repo.upsertAgent({ handle: 'old-runner', role: 'Выведен из строя.', active: false })
  assert.ok(repo.listAgents().some((a) => a.handle === 'old-runner'))
  assert.ok(!repo.listAgents({ activeOnly: true }).some((a) => a.handle === 'old-runner'))
})

t('the participants of a set of handles come back in one query, unknown ones simply absent', () => {
  const found = repo.getAgents(['mcp-core', 'photoking agents', IDENTITY_OWNER]).map((a) => a.handle).sort()
  assert.deepEqual(found, ['mcp-core', IDENTITY_OWNER].sort())
})

t('a roster row under an empty name is refused loudly — a directory entry nobody can address', () => {
  assert.throws(() => repo.upsertAgent({ handle: '   ' }), /not a usable identity/)
  assert.throws(() => repo.touchAgent(''), /not a usable identity/)
})

console.log(`db/roster: all ${passed} tests passed ✓`)
