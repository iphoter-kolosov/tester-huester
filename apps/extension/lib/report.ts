// The exact JSON the collector's /api/ingest expects. Kept pure (no chrome/DOM) so it is unit-testable and
// so the content script and any other client build reports identically.
export type ReportPayload = {
  ingestKey: string
  note: string
  screenshot?: string
  pageUrl: string
  viewport: string
  userAgent: string
}

export function buildReport(o: {
  ingestKey: string
  note: string
  screenshot?: string
  pageUrl: string
  innerWidth: number
  innerHeight: number
  userAgent: string
}): ReportPayload {
  return {
    ingestKey: o.ingestKey,
    note: o.note.trim(),
    screenshot: o.screenshot,
    pageUrl: o.pageUrl,
    viewport: `${o.innerWidth}x${o.innerHeight}`,
    userAgent: o.userAgent,
  }
}
