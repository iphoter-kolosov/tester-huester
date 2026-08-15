import { NextResponse } from 'next/server'
import {
  repo,
  normalizeAgentRole,
  normalizeAgentTitle,
  normalizeIdentity,
  IDENTITY_OWNER,
  MAX_AGENT_ROLE_LEN,
  MAX_AGENT_TITLE_LEN,
  type AgentProfile,
} from '@th/db'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The roster: who works this board, what each of them does, and whether they are still alive. This is the call an
// agent makes BEFORE handing work over — addressing a ticket to a handle nobody answers to is how `assignee` came
// to be empty on every ticket the board had.
//
// Auth mirrors the rest of the API: `?projectKey=<read_key>` for agents, the dashboard cookie for the owner. The
// roster itself is NOT scoped to one project — a handle is one agent everywhere, and an agent that could only see
// its own board could not learn who else exists to hand work to. `boards` on each row says where each one works.
async function authorize(req: Request): Promise<{ owner: boolean; projectId: string | null } | { error: NextResponse }> {
  const key = new URL(req.url).searchParams.get('projectKey') || ''
  if (key) {
    const project = repo.getProjectByReadKey(key)
    if (!project) return { error: NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 }) }
    return { owner: false, projectId: project.id }
  }
  if (!(await isAuthed())) {
    return {
      error: NextResponse.json(
        { ok: false, error: 'unauthorized', message: 'Pass ?projectKey=<read_key> as an agent, or sign in to the dashboard as the owner.' },
        { status: 401 },
      ),
    }
  }
  return { owner: true, projectId: null }
}

// ?active=1 drops retired agents (the ones that should no longer be offered as an assignee); ?board=<projectId>
// narrows to one board. Both default off: the full roster is the useful answer, and it is small.
export async function GET(req: Request) {
  const auth = await authorize(req)
  if ('error' in auth) return auth.error
  const url = new URL(req.url)
  const activeOnly = url.searchParams.get('active') === '1'
  const board = url.searchParams.get('board') || undefined
  const agents = repo.listAgents({ activeOnly, board })
  return NextResponse.json({ ok: true, count: agents.length, agents })
}

type Description = { title?: string | null; role?: string | null; active?: boolean }

/**
 * Read the describable fields. Absent fields stay absent (the repo leaves them as they were); a field that was
 * SENT but is unusable is a refusal, because an agent that meant to describe itself and instead cleared its own
 * entry would have no way of noticing.
 */
function readDescription(body: Record<string, unknown>): { desc: Description } | { error: NextResponse } {
  const out: Description = {}
  if ('title' in body) {
    const title = normalizeAgentTitle(body.title)
    if (body.title != null && body.title !== '' && !title) {
      return {
        error: NextResponse.json(
          { ok: false, error: 'bad_title', message: `"title" must be a short human name (up to ${MAX_AGENT_TITLE_LEN} characters), e.g. "MCP-ядро".` },
          { status: 400 },
        ),
      }
    }
    out.title = title
  }
  if ('role' in body) {
    const role = normalizeAgentRole(body.role)
    if (body.role != null && body.role !== '' && !role) {
      return {
        error: NextResponse.json(
          { ok: false, error: 'bad_role', message: `"role" must say in one or two sentences (up to ${MAX_AGENT_ROLE_LEN} characters) what this agent DOES and answers for — it is what another agent reads before addressing work to it.` },
          { status: 400 },
        ),
      }
    }
    out.role = role
  }
  if ('active' in body) {
    if (typeof body.active !== 'boolean') {
      return {
        error: NextResponse.json(
          { ok: false, error: 'bad_active', message: '"active" must be true or false — false means "do not offer me as an assignee any more".' },
          { status: 400 },
        ),
      }
    }
    out.active = body.active
  }
  return { desc: out }
}

async function readBody(req: Request): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    return { body: (await req.json()) as Record<string, unknown> }
  } catch {
    return { error: NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }) }
  }
}

/**
 * Register or describe YOURSELF: `{ agent, title?, role?, active? }`.
 *
 * There is no parameter for whose entry to write, and that is the enforcement: the row written is the identity the
 * request declares, so an agent structurally cannot describe another one. It is not a security boundary and does
 * not pretend to be — every agent on a board shares the read key and could already declare any name (see the
 * identity notes in verify.ts) — but it does mean no agent edits a colleague's entry by accident or by typo.
 * Correcting somebody else's row is the owner's job: PATCH, below.
 *
 * The owner posting here describes his OWN roster row, like anyone else.
 */
export async function POST(req: Request) {
  const auth = await authorize(req)
  if ('error' in auth) return auth.error
  const read = await readBody(req)
  if ('error' in read) return read.error
  const body = read.body

  const declared = normalizeIdentity(body.agent)
  const handle = auth.owner ? IDENTITY_OWNER : declared
  if (!handle) {
    return NextResponse.json(
      {
        ok: false,
        error: 'agent_required',
        message:
          'Send "agent": the identity you act under, e.g. "mcp-core". It is the handle this entry describes and the ' +
          'name your writes are attributed to — there is no way to register anyone else, by design.',
      },
      { status: 400 },
    )
  }
  if (auth.owner && declared && declared !== IDENTITY_OWNER) {
    return NextResponse.json(
      {
        ok: false,
        error: 'not_yourself',
        message: `POST describes the caller's own entry, and signed in to the dashboard you are "${IDENTITY_OWNER}". Use PATCH with {handle} to edit another agent.`,
      },
      { status: 400 },
    )
  }

  const described = readDescription(body)
  if ('error' in described) return described.error
  repo.upsertAgent({ handle, ...described.desc, board: auth.projectId })
  // Describing yourself is also an act, so the liveness stamp moves — unlike the owner's PATCH below, which is
  // somebody else writing ABOUT this agent and says nothing about whether it is still running.
  repo.touchAgent(handle, auth.projectId)
  const agent: AgentProfile = repo.getAgent(handle)!
  return NextResponse.json({ ok: true, agent })
}

/**
 * The owner corrects any entry: `{ handle, title?, role?, active? }`. This is how a handle that registered itself
 * by acting — and therefore has no title and no role — gets described, and how an agent that has gone away is
 * retired (`active: false`) so nobody addresses work to it.
 */
export async function PATCH(req: Request) {
  if (!(await isAuthed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const read = await readBody(req)
  if ('error' in read) return read.error
  const body = read.body

  const handle = normalizeIdentity(body.handle)
  if (!handle) {
    return NextResponse.json({ ok: false, error: 'bad_handle', message: 'Send "handle": the canonical identity of the agent to edit (GET /api/agents lists them).' }, { status: 400 })
  }
  // Editing is for entries that exist. A typo would otherwise mint a ghost agent that other agents can then be
  // told to address work to.
  if (!repo.getAgent(handle)) {
    return NextResponse.json(
      { ok: false, error: 'unknown_agent', message: `No agent "${handle}" on the roster. An agent appears there when it first acts under a declared identity; GET /api/agents lists who exists.` },
      { status: 404 },
    )
  }
  const described = readDescription(body)
  if ('error' in described) return described.error
  if (!Object.keys(described.desc).length) {
    return NextResponse.json({ ok: false, error: 'nothing_to_update', message: 'Send at least one of "title", "role", "active".' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, agent: repo.upsertAgent({ handle, ...described.desc }) })
}
