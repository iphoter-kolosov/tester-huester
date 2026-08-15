import { NextResponse } from 'next/server'
import {
  repo,
  buildConnectSnippet,
  buildInstructions,
  CONNECT_RESTART_NOTE,
  type Project,
} from '@th/db'
import { isAuthed } from '@/lib/auth'
import { collectorBase } from '@/lib/collector'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The onboarding text over HTTP — the same string the MCP servers hand out on initialize, from the same builder
// (@th/db onboarding.ts). This exists so the answer to "where do the agents of this project talk, and how do I
// join" has exactly ONE author: an agent that is not connected yet cannot receive MCP instructions, and the owner
// needs something to paste. Both read the text the code enforces, never a copy somebody remembered to update.
//
// Auth mirrors the rest of the agent-facing API: `?projectKey=<read_key>` for an agent, the dashboard cookie for
// the owner (who must name the project, since the cookie is not scoped to one).
//
// WHAT THIS HANDS OUT: the connection snippet carries a credential, so the endpoint is reachable only by someone
// who already holds one. For an agent that is the read key it just presented — nothing new is disclosed. The
// INGEST key is never emitted here at all, by anyone: this route is authenticated by a READ key, and a read key
// that can fetch the write key is not read-scoped. The snippet names it as a placeholder and says where the owner
// takes it from.

type Access = { project: Project; owner: boolean }

async function authorize(req: Request): Promise<Access | { error: NextResponse }> {
  const url = new URL(req.url)
  const key = url.searchParams.get('projectKey') || ''
  if (key) {
    const project = repo.getProjectByReadKey(key)
    if (!project) return { error: NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 }) }
    return { project, owner: false }
  }
  return authorizeOwner(req)
}

/**
 * The owner path. The cookie proves who is asking but not WHICH board, so the project has to be named — and a
 * missing name is answered with the list of ids rather than a guess, because guessing would hand out the read key
 * of a project the owner did not ask about.
 */
async function authorizeOwner(req: Request): Promise<Access | { error: NextResponse }> {
  if (!(await isAuthed())) {
    return {
      error: NextResponse.json(
        { ok: false, error: 'unauthorized', message: 'Pass ?projectKey=<read_key> as an agent, or sign in to the dashboard as the owner.' },
        { status: 401 },
      ),
    }
  }
  const wanted = new URL(req.url).searchParams.get('project') || ''
  const projects = repo.listProjects()
  if (!wanted) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: 'project_required',
          message: 'Signed in as the owner, name the board: ?project=<id>. The snippet carries that project\'s read key, so it is never guessed.',
          projects: projects.map((p) => ({ id: p.id, name: p.name })),
        },
        { status: 400 },
      ),
    }
  }
  const project = projects.find((p) => p.id === wanted || p.name === wanted)
  if (!project) {
    return {
      error: NextResponse.json(
        { ok: false, error: 'unknown_project', message: `No project "${wanted}".`, projects: projects.map((p) => ({ id: p.id, name: p.name })) },
        { status: 404 },
      ),
    }
  }
  return { project, owner: true }
}

export async function GET(req: Request) {
  const auth = await authorize(req)
  if ('error' in auth) return auth.error
  const { project } = auth

  // Read over the whole roster, not this board's slice: a handle is one agent everywhere, and the agent reading
  // this is about to be told to address work to somebody — the colleague it needs may simply not have touched
  // this board yet.
  const instructions = buildInstructions({
    boardName: project.name,
    // Nobody is connected over this transport, so there is no identity to report — the text falls back to the
    // generic "say who you are", which is exactly the advice a not-yet-configured agent needs.
    identity: { kind: 'unknown' },
    roster: { kind: 'known', agents: repo.listAgents() },
  })
  const connect = buildConnectSnippet({ collector: collectorBase(req.headers), readKey: project.readKey })

  if (new URL(req.url).searchParams.get('format') === 'text') {
    return new NextResponse([instructions, '', 'CONNECT:', connect, '', CONNECT_RESTART_NOTE, ''].join('\n'), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return NextResponse.json({
    ok: true,
    project: { id: project.id, name: project.name },
    instructions,
    connect: { snippet: connect, note: CONNECT_RESTART_NOTE },
  })
}
