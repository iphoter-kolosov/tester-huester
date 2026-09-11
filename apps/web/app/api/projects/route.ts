import { NextResponse } from 'next/server'
import { repo, IDENTITY_EXTENSION, type AgentProfile, type Project } from '@th/db'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Lets the extension overlay show a "send to which project" picker. Gated by a valid ingest key (the extension
// already holds one) — single-tenant, so any valid ingest key may list the account's projects. Returns id+name
// only (never the keys). CORS-open because the extension calls it from a content-script/background on any origin.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-key',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

/** What the overlay needs to render one option: a person, not a slug. `role` is the hover text. */
type AssignableAgent = { handle: string; title: string; role: string }

/**
 * Who a capture may be addressed to, and on which board each of them belongs.
 *
 * The extension holds an INGEST key, and GET /api/agents takes a READ key or the owner cookie — so the roster is
 * answered HERE, on the one call the overlay already makes. One round trip, no second credential in the browser,
 * and the picker can repopulate the instant the project changes without touching the network again.
 *
 * Assignable = active AND not the extension channel itself. `active: false` already hides the channel (that is how
 * it is kept from being given work), but the exclusion is written out anyway: this is the endpoint the extension
 * asks "whom can I hand this to", and offering the extension its own handle would be nonsense even if somebody
 * flipped that flag by hand.
 *
 * EVERY active agent is offered on EVERY board — not just the ones whose `boards` already lists this project.
 * checkAssignee, the validator this picker has to agree with, does not look at boards at all, so an agent that
 * simply has not yet TOUCHED this particular board is a valid addressee the server would accept; narrowing the
 * picker to board members was a standing trap, not a feature — it made "assign this to the agent I know does this
 * work" impossible on the one occasion it matters most: a brand-new board, before that agent has ever connected to
 * it. `onBoard` on each project entry is the ordering hint: agents already regulars here come first in `assignable`
 * (and the extension can group by it), everyone else follows — so a long roster still surfaces the usual suspects
 * first without ever hiding somebody the collector would happily accept.
 */
function assignableByProject(projects: Project[]): { agents: AssignableAgent[]; assignable: Record<string, string[]>; onBoard: Record<string, string[]> } {
  const roster: AgentProfile[] = repo.listAgents({ activeOnly: true }).filter((a) => a.handle !== IDENTITY_EXTENSION)
  const assignable: Record<string, string[]> = {}
  const onBoard: Record<string, string[]> = {}
  for (const p of projects) {
    const regulars = roster.filter((a) => a.boards.includes(p.id))
    const others = roster.filter((a) => !a.boards.includes(p.id))
    assignable[p.id] = [...regulars, ...others].map((a) => a.handle)
    onBoard[p.id] = regulars.map((a) => a.handle)
  }
  return { agents: roster.map(({ handle, title, role }) => ({ handle, title, role })), assignable, onBoard }
}

export function GET(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('ingestKey') || req.headers.get('x-ingest-key') || ''
  const own = key ? repo.getProjectByKey(key) : null
  if (!own) {
    return NextResponse.json({ ok: false, error: 'bad_key' }, { status: 401, headers: CORS })
  }
  // id+name only — never the keys. `defaultId` = the project this ingest key belongs to, so the overlay can
  // preselect it. The overlay sends the chosen id back as `projectId` on ingest.
  //
  // `agents` is a dictionary and each project carries only HANDLES into it: a role runs to several hundred
  // characters and most agents work several boards, so embedding the profiles per project would ship the same
  // paragraphs over and over. The client resolves a handle through the dictionary; the decision of who is
  // assignable where stays entirely on this side.
  const rows = repo.listProjects()
  const { agents, assignable, onBoard } = assignableByProject(rows)
  // `onBoard` is a subset of `assignable`, listed separately rather than nested per-handle: it lets the picker
  // group "regulars here" from "everyone else" without re-deriving that split from ordering alone.
  const projects = rows.map((p) => ({ id: p.id, name: p.name, assignable: assignable[p.id]!, onBoard: onBoard[p.id]! }))
  return NextResponse.json({ ok: true, projects, agents, defaultId: own.id }, { headers: CORS })
}

/** Two boards whose names differ only by case or padding are one board to a human — matching that way is what
 *  makes this endpoint safe to run twice. */
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Create a board and hand back BOTH of its keys: `{ "name": "…" }` → `{ ok, created, project }`.
 *
 * Deliberately owner-cookie only, and deliberately NOT under the CORS block above: this is the one route in the
 * app that returns `readKey` and `ingestKey`, and until now those existed only inside a cookie-gated HTML page.
 * An ingest key must not be able to mint a board with fresh keys, so the extension's auth is not accepted here.
 * Sign in first with POST /api/session and send the th_auth cookie back.
 *
 * Idempotent by name, because the caller is a setup script that is expected to be re-run: an existing board is
 * returned as-is with `created: false` rather than silently duplicated under the same name — two boards with one
 * name is a trap the owner would only find later, when half the tickets are on the wrong one.
 */
export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json(
      {
        ok: false,
        error: 'unauthorized',
        message:
          'Creating a board mints its keys, so it is the owner\'s call: POST /api/session {"password": …} first and send the th_auth cookie back. An ingest or read key is not accepted here.',
      },
      { status: 401 },
    )
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json', message: 'Send a JSON body: {"name": "<board name>"}.' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json(
      { ok: false, error: 'name_required', message: 'Send "name": how the board is called on the dashboard, e.g. "erental".' },
      { status: 400 },
    )
  }

  const existing = repo.listProjects().find((p) => sameName(p.name, name))
  const project: Project = existing ?? repo.createProject(name)
  return NextResponse.json({
    ok: true,
    created: !existing,
    project: { id: project.id, name: project.name, readKey: project.readKey, ingestKey: project.ingestKey },
  })
}
