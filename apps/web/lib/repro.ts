import type { Report } from '@th/db'
import { reproSteps, type ReproBundle } from '@th/core/repro'

// The single source of truth for turning a stored report into an agent-ready reproduction. Both the REST
// read-API (`GET /api/reports/[id]/repro`) and the MCP `get_repro_steps` tool call this so they never drift.
// Depends only on @th/db (types) and @th/core/repro (pure helpers) — both of which apps/web and apps/mcp
// declare — so this file resolves identically whether imported by Next or by the MCP process.
export type ReproResult =
  | { kind: 'none'; message: string }
  | {
      kind: 'repro'
      report: { id: string; note: string; pageUrl: string | null; status: string; type: string; severity: string | null }
      environment: ReproBundle['env']
      steps: string[]
      consoleErrors: string[]
      failedRequests: string[]
    }

export function buildRepro(r: Report): ReproResult {
  const ctx = r.context as ReproBundle | null
  if (!ctx) {
    return { kind: 'none', message: `report ${r.id} has no captured repro context (screenshot/note only).` }
  }
  const steps = reproSteps(ctx)
  const errors = (ctx.console ?? []).filter((c) => c.level === 'error')
  const failed = (ctx.network ?? []).filter((n) => n.status === 0 || n.status >= 400)
  return {
    kind: 'repro',
    report: { id: r.id, note: r.note, pageUrl: r.pageUrl, status: r.status, type: r.type, severity: r.severity },
    environment: ctx.env,
    steps: steps.length ? steps : ['(no user actions were recorded)'],
    consoleErrors: errors.map((e) => e.text),
    failedRequests: failed.map((n) => `${n.method} ${n.url} → ${n.status || 'ERR'} (${n.ms}ms)`),
  }
}
