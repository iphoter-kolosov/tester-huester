import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The agent-to-agent loop, driven exactly as an agent drives it — over stdio, through the MCP server, against a
// throwaway database. Proves the half of the contract that cannot be read off the types: that the FILER of a
// ticket is the only agent allowed to accept the work, that a work report without proof is refused, and that both
// servers expose the same tools.
//
//   pnpm --filter @th/mcp exec tsx src/agents-e2e.ts
//
// Nothing here touches the real th.db: SQLITE_FILE is pointed at a temp file BEFORE @th/db is imported (hence the
// dynamic import — a static one would be hoisted above the assignment and open the wrong database).
const here = path.dirname(fileURLToPath(import.meta.url))
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-agents-')), 'th.db')
process.env.SQLITE_FILE = dbFile

const { repo } = await import('@th/db')
const project = repo.createProject('agents-e2e')

const FILER = 'filer-agent'
const EXECUTOR = 'executor-agent'
const THIRD = 'third-agent'
const LINK = 'https://example.test/screen?id=7'

function connect(entry: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, entry)],
    // The package directory, so `--import tsx` resolves however this script was launched from.
    cwd: path.join(here, '..'),
    env: { ...(process.env as Record<string, string>), ...env },
  })
  const client = new Client({ name: 'agents-e2e', version: '0.0.0' })
  return client.connect(transport).then(() => client)
}

// TH_AGENT is blanked rather than inherited: whether this server has an identity of its own is the thing under
// test below, and an operator with TH_AGENT set in their shell would otherwise silently change the answer.
const local = await connect('index.ts', { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey, TH_AGENT: '' })

const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await local.callTool({ name, arguments: args })
  return (res.content as Array<{ type: string; text: string }>)[0]!.text
}

type WhoAmIAnswer = {
  identity: string
  source: string
  registered: boolean
  roster: { role: string; active: boolean } | null
  board: { name: string } | null
  warnings: string[]
  next: string[]
}
const whoami = async (args: Record<string, unknown> = {}): Promise<WhoAmIAnswer> =>
  JSON.parse(await call('whoami', args)) as WhoAmIAnswer

// ── an agent can say who it is, and is told when it has no name of its own ──────────────────────────────────
const anonymous = await whoami()
assert.equal(anonymous.source, 'fallback', 'with nothing declared the identity is a fallback, and says so')
assert.equal(anonymous.identity, 'agents-e2e', 'and the fallback is the BOARD name — the defect made visible')
assert.equal(anonymous.board?.name, 'agents-e2e', 'whoami names the board it is pinned to')
assert.ok(anonymous.warnings.some((w) => w.includes('TH_AGENT')), 'the fallback is warned about, not just reported')
assert.ok(anonymous.next.some((n) => n.includes('list_agents')), 'and it is told to read the roster before addressing work')

const declared = await whoami({ agent: FILER })
assert.equal(declared.source, 'declared', 'a declared identity is reported as declared')
assert.equal(declared.registered, false, 'and it is not on the roster until it acts or registers')

// ── the roster starts with the two participants that exist before any agent ─────────────────────────────────
type Roster = { count: number; agents: { handle: string; role: string; active: boolean }[] }
const seeded = JSON.parse(await call('list_agents', {})) as Roster
assert.deepEqual(seeded.agents.map((a) => a.handle).sort(), ['extension', 'owner'], 'owner and extension are seeded')
assert.ok(
  seeded.agents.every((a) => a.role.length > 0),
  'both seeded entries describe themselves — a reader of a thread never meets a bare handle',
)

// ── agents put themselves on the roster ─────────────────────────────────────────────────────────────────────
const registered = JSON.parse(
  await call('register_agent', { agent: EXECUTOR, title: 'Исполнитель', role: 'Чинит витрину; в админку не лезет.' }),
) as { agent: { handle: string; role: string; boards: string[] } }
assert.equal(registered.agent.handle, EXECUTOR)
assert.match(registered.agent.role, /Чинит витрину/, 'the role is stored as written')
assert.deepEqual(registered.agent.boards, [project.id], 'and the agent is recorded as working THIS board')

assert.match(
  await call('register_agent', { agent: EXECUTOR, active: true }),
  /Чинит витрину/,
  'registering again without a role does not blank the one already written',
)
assert.match(await call('register_agent', { agent: EXECUTOR }), /at least one of/, 'a register that describes nothing is refused')
assert.match(await call('register_agent', { agent: EXECUTOR, title: '   ' }), /^bad_title/, 'a blank title would erase the real one, so it is refused')
assert.match(
  await call('register_agent', {}),
  /TH_AGENT/,
  'a server with no identity of its own cannot register: putting the BOARD on the roster is the defect being fixed',
)
assert.equal(repo.getAgent('agents-e2e'), null, 'and the board name never became an agent')

assert.match(await call('register_agent', { agent: FILER, role: 'Ставит задачи и принимает работу.' }), /Ставит задачи/)

const roster = JSON.parse(await call('list_agents', { activeOnly: true })) as Roster
assert.ok(roster.agents.some((a) => a.handle === EXECUTOR), 'the executor is now addressable')
assert.ok(!roster.agents.some((a) => a.handle === 'extension'), 'the retired capture channel is not offered as one')

// ── an agent files work for another agent ───────────────────────────────────────────────────────────────────
const typo = await call('create_task', { assignee: 'executor-agnet', title: 'x', body: 'y', agent: FILER })
assert.match(typo, /^unknown_assignee/, 'a task addressed to a handle nobody answers to is refused')
assert.match(typo, /executor-agent/, 'and the refusal carries the roster, so the caller learns the board in one round trip')
assert.ok(!typo.includes('extension'), 'the retired entry is not offered — taking the suggestion would earn a second refusal')
assert.equal(repo.listReports({ projectId: project.id }).length, 0, 'nothing was filed into the void')

assert.match(
  await call('create_task', { assignee: 'extension', title: 'x', body: 'y', agent: FILER }),
  /^assignee_inactive/,
  'a retired entry is refused as an addressee, and said to be retired rather than unknown',
)
const filed = await call('create_task', {
  assignee: EXECUTOR,
  title: 'Кнопка «Проверить» не открывает экран',
  body: 'На карточке тикета ссылка ведёт на корень сайта вместо конкретного экрана.',
  type: 'fix',
  severity: 'high',
  links: [LINK],
  agent: FILER,
})
const id = /id ([0-9a-f-]{36})$/.exec(filed.trim())?.[1]
assert.ok(id, `create_task returned an id: ${filed}`)
const row = repo.getReport(id)!
assert.equal(row.creator, FILER, 'the filer is recorded as creator')
assert.equal(row.assignee, EXECUTOR, 'the task is addressed to the executor')
assert.equal(row.pageUrl, LINK, 'the first link became the page URL')
assert.equal(row.type, 'fix')
assert.equal(row.severity, 'high')
assert.match(row.note, /Ссылки:/, 'the links block is in the note')

const badLink = await call('create_task', { assignee: EXECUTOR, title: 'x', body: 'y', links: ['/relative'], agent: FILER })
assert.match(badLink, /Not absolute http\(s\) links/, 'a relative link is refused, not silently dropped')
assert.equal(repo.listReports({ projectId: project.id }).length, 1, 'the refused task was not filed')

// ── each side sees its own plate ────────────────────────────────────────────────────────────────────────────
const plateExec = JSON.parse(await call('my_tasks', { agent: EXECUTOR })) as { assigned: { id: string }[]; filed: unknown[] }
assert.equal(plateExec.assigned.length, 1, 'the executor sees the task in its inbox')
assert.equal(plateExec.filed.length, 0, 'the executor did not file it')
const plateFiler = JSON.parse(await call('my_tasks', { agent: FILER })) as { assigned: unknown[]; filed: { id: string }[] }
assert.equal(plateFiler.filed[0]?.id, id, 'the filer sees it as theirs to accept')
assert.equal(plateFiler.assigned.length, 0, 'the filer is not the one doing it')

const inbox = JSON.parse(await call('get_updates', { agent: EXECUTOR, filter: ['inbox'] })) as { count: number; cursor: number }
assert.ok(inbox.count >= 1, 'the created event reaches the executor through the inbox filter')
assert.ok(inbox.cursor > 0, 'a filtered read still reports how far it scanned')
const strangerInbox = JSON.parse(await call('get_updates', { agent: THIRD, filter: ['inbox'] })) as { count: number; cursor: number }
assert.equal(strangerInbox.count, 0, 'an uninvolved agent sees nothing in its inbox')
assert.equal(strangerInbox.cursor, inbox.cursor, 'but it is told the same scan position — acking it drops nothing')

// ── the executor works and hands it back ────────────────────────────────────────────────────────────────────
assert.match(await call('set_status', { id, status: 'taken', agent: EXECUTOR }), /→ taken/, 'taking a ticket needs nothing else')
assert.equal(repo.getReport(id)!.takenBy, EXECUTOR, 'taking stamps the holder')

const noProof = await call('set_status', { id, status: 'needs_review', agent: EXECUTOR, comment: 'сделал', verifyUrl: LINK, verifySteps: ['открыть'] })
assert.match(noProof, /^evidence_required/, 'a work report without proof is refused')
assert.equal(repo.getReport(id)!.status, 'taken', 'and the refused transition changed nothing')

const submitted = await call('submit_report', {
  id,
  agent: EXECUTOR,
  comment: 'Ссылка строилась от корня. Теперь берётся pageUrl тикета. Коммит a1b2c3d.',
  verifyUrl: LINK,
  verifySteps: ['Открыть тикет', 'Нажать «Проверить»', 'Открывается тот самый экран'],
  evidence: 'verify.test.ts: 42 passed',
})
assert.match(submitted, /→ needs_review/, 'submit_report moves the ticket')
assert.equal(repo.getReport(id)!.status, 'needs_review')
assert.equal(repo.listComments(id).at(-1)!.evidence, 'verify.test.ts: 42 passed', 'the proof is stored on the comment')

// ── only the filer closes it ────────────────────────────────────────────────────────────────────────────────
const selfAccept = await call('set_status', { id, status: 'verified', agent: EXECUTOR })
assert.match(selfAccept, /^not_your_call/, 'the executor cannot mark its own work accepted')
assert.equal(repo.getReport(id)!.status, 'needs_review', 'and the ticket stays where it was')

const review = JSON.parse(await call('get_updates', { agent: FILER, filter: ['review'] })) as { count: number }
assert.ok(review.count >= 1, 'the filer is told its ticket is waiting for a verdict')

const noReason = await call('set_status', { id, status: 'rejected', agent: FILER })
assert.match(noReason, /^comment_required/, 'a rework order with no reason is refused even from the filer')
assert.match(await call('set_status', { id, status: 'rejected', agent: FILER, comment: 'Ссылка всё ещё без id.' }), /→ rejected/)

const rework = JSON.parse(await call('get_updates', { agent: EXECUTOR, filter: ['rework'] })) as { count: number }
assert.ok(rework.count >= 1, 'the rejection comes back to whoever held the ticket')
assert.match(await call('set_status', { id, status: 'verified', agent: FILER }), /→ verified/, 'the filer accepts')

// ── handover and back-compatibility ─────────────────────────────────────────────────────────────────────────
const strangerHandover = await call('assign_task', { id, assignee: THIRD, agent: FILER })
assert.match(strangerHandover, /^unknown_assignee/, 'work cannot be handed to an agent that is not on the roster')
assert.equal(repo.getReport(id)!.assignee, EXECUTOR, 'and the refused handover left the ticket where it was')

// An agent joins the roster by ACTING under a declared identity — no registration call needed, which is what lets
// it take work on its very first call and address a ticket to itself.
assert.match(await call('add_comment', { id, body: 'Беру на себя.', agent: THIRD }), /as "third-agent"/)
assert.equal(repo.getAgent(THIRD)?.handle, THIRD, 'the comment alone put the third agent on the roster')
assert.equal(repo.getAgent(THIRD)?.role, '', 'described by nobody yet — which whoami and the roster both say out loud')
const newcomer = JSON.parse(await call('whoami', { agent: THIRD })) as WhoAmIAnswer
assert.equal(newcomer.registered, true)
assert.ok(newcomer.warnings.some((w) => w.includes('register_agent')), 'and it is told to describe itself')

assert.match(await call('assign_task', { id, assignee: THIRD, agent: FILER }), /is now for "third-agent"/)
assert.equal(repo.getReport(id)!.assignee, THIRD)
const blank = await call('assign_task', { id, assignee: '   ', agent: FILER })
assert.match(blank, /^bad_assignee/, 'a blank assignee is not "unassign"')
assert.match(blank, /Send null/, 'and it is told what "unassign" actually is')
assert.equal(repo.getReport(id)!.assignee, THIRD, 'and it did not detach the ticket')

// A client written before the lifecycle existed still works, under exactly the contract it was written against.
const legacyTask = await call('create_task', { assignee: EXECUTOR, title: 'legacy', body: 'проверка старого клиента', agent: FILER })
const legacyId = /id ([0-9a-f-]{36})$/.exec(legacyTask.trim())![1]!
assert.match(await call('set_status', { id: legacyId, status: 'triaged' }), /→ taken/, "'triaged' still maps to taken")
assert.match(
  await call('set_status', { id: legacyId, status: 'fixed', comment: 'готово', verifyUrl: LINK }),
  /→ needs_review/,
  "'fixed' from an agent still lands in needs_review on the old two-part contract",
)

// Everything above included calls with no identity at all (the legacy pair). Not one of them may have put the
// board on the roster: that is precisely how "erental" and "photoking agents" came to look like agents.
assert.equal(repo.getAgent('agents-e2e'), null, 'no unnamed call ever registered the board as an agent')

// ── TH_AGENT is a real identity, and the server says which one it is using ──────────────────────────────────
const configured = await connect('index.ts', { SQLITE_FILE: dbFile, TH_PROJECT_KEY: project.readKey, TH_AGENT: 'Env-Agent' })
const envWho = JSON.parse(
  ((await configured.callTool({ name: 'whoami', arguments: {} })).content as Array<{ text: string }>)[0]!.text,
) as WhoAmIAnswer
assert.equal(envWho.source, 'env', 'a configured identity is reported as coming from the environment')
assert.equal(envWho.identity, 'env-agent', 'and it is canonicalised, so it matches what the writes are stored as')
assert.ok(!envWho.warnings.some((w) => w.includes('TH_AGENT')), 'a server that HAS an identity is not nagged about it')
await configured.close()

// ── one surface, two servers ────────────────────────────────────────────────────────────────────────────────
const remote = await connect('remote.ts', { TH_COLLECTOR: 'http://127.0.0.1:9', TH_PROJECT_KEY: 'thr_unused_in_this_check' })
const names = (t: { tools: { name: string }[] }): string[] => t.tools.map((x) => x.name).sort()
const localNames = names(await local.listTools())
const remoteNames = names(await remote.listTools())
assert.deepEqual(localNames, remoteNames, `the two servers must offer the same tools\n local: ${localNames}\nremote: ${remoteNames}`)
console.log(`tools (both servers): ${localNames.join(', ')}`)

await local.close()
await remote.close()
// The repo keeps its connection open for the life of the process and Windows will not unlink an open file, so a
// failure here is housekeeping, not a failed check — but it says where the leftovers are instead of hiding them.
try {
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })
} catch (e) {
  console.log(`temp database left at ${path.dirname(dbFile)} (${String(e)})`)
}
console.log('agents-e2e: done ✓')
process.exit(0)
