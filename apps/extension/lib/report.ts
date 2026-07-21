import type { ReproBundle } from '@th/core'

// Shared contract with the collector + dashboard (track A). Keep these names/values exact — /api/ingest
// validates them and writes reports.type / reports.severity.
export type ReportType = 'feature' | 'bug' | 'fix' | 'text' // RU labels in UI: Фича / Баг / Правка / Текст
export type Severity = 'low' | 'med' | 'high' | 'crit'

export const DEFAULT_TYPE: ReportType = 'bug'
export const DEFAULT_SEVERITY: Severity = 'med'

// The exact JSON the collector's /api/ingest expects. Kept pure (no chrome/DOM) so it is unit-testable and
// so the content script and any other client build reports identically.
export type ReportPayload = {
  ingestKey: string
  note: string
  type: ReportType
  severity: Severity
  screenshot?: string
  pageUrl: string
  viewport: string
  userAgent: string
  context?: ReproBundle
}

export function buildReport(o: {
  ingestKey: string
  note: string
  type?: ReportType
  severity?: Severity | null
  screenshot?: string
  pageUrl: string
  innerWidth: number
  innerHeight: number
  userAgent: string
  context?: ReproBundle | null
}): ReportPayload {
  return {
    ingestKey: o.ingestKey,
    note: o.note.trim(),
    type: o.type ?? DEFAULT_TYPE,
    severity: o.severity ?? DEFAULT_SEVERITY,
    screenshot: o.screenshot,
    pageUrl: o.pageUrl,
    viewport: `${o.innerWidth}x${o.innerHeight}`,
    userAgent: o.userAgent,
    context: o.context ?? undefined,
  }
}
