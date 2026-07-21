import { NextResponse } from 'next/server'
import { repo, type Project } from '@th/db'

// Auth for the agent-facing REST read-API: `?projectKey=<read_key>` resolves to exactly one project and
// scopes every read to it. This is deliberately separate from the dashboard cookie (humans) and the ingest
// key (writes) — a read key is single-project, read-only, safe to hand to an agent.
export function resolveProjectKey(req: Request): { project: Project } | { error: NextResponse } {
  const url = new URL(req.url)
  const key = url.searchParams.get('projectKey') || ''
  if (!key) {
    return { error: NextResponse.json({ ok: false, error: 'missing_project_key' }, { status: 401 }) }
  }
  const project = repo.getProjectByReadKey(key)
  if (!project) {
    return { error: NextResponse.json({ ok: false, error: 'bad_project_key' }, { status: 403 }) }
  }
  return { project }
}
