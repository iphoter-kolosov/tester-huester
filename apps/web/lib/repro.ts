import type { Report } from '@th/db'
import { reproSteps, type ReproBundle } from '@th/core/repro'

// The single source of truth for turning a stored report into an agent-ready reproduction. Both the REST
// read-API (`GET /api/reports/[id]/repro`) and the MCP `get_repro_steps` tool call this so they never drift.
// Depends only on @th/db (types) and @th/core/repro (pure helpers) — both of which apps/web and apps/mcp
// declare — so this file resolves identically whether imported by Next or by the MCP process.
// `visual` is the part an agent must not skip: a recording exists, and these stills are how it can actually
// see it (a model reads images, not a webm). It is present even when there is no context bundle, because a
// report can be video-only and that video is still the best evidence in it.
export type ReproVisual = {
  hasVideo: boolean
  videoUrl: string | null
  videoSeconds: number | null
  watchRange: { from: number; to: number } | null
  frames: { at: number; url: string }[]
  screenshotUrl: string | null
  instruction: string
}

export type ReproResult =
  | { kind: 'none'; message: string; visual?: ReproVisual }
  | {
      kind: 'repro'
      report: { id: string; note: string; pageUrl: string | null; status: string; type: string; severity: string | null }
      visual: ReproVisual
      environment: ReproBundle['env']
      steps: string[]
      consoleErrors: string[]
      failedRequests: string[]
    }

function buildVisual(r: Report): ReproVisual {
  const frames = r.videoFrames ?? []
  const instruction = r.videoUrl
    ? `This report has a SCREEN RECORDING (${r.videoSeconds ?? '?'}s)${r.videoTrim ? `, and the reporter selected ${r.videoTrim.from.toFixed(1)}s–${r.videoTrim.to.toFixed(1)}s as the part that matters` : ''}. ` +
      (frames.length
        ? `You cannot play video, so LOOK AT THE ${frames.length} FRAMES below (each with its timestamp) before forming any theory — they show what the reporter saw, in order. Fetch each frame URL and view it as an image.`
        : `No frames were extracted, so ask the reporter (add_comment) what happens in the recording, or open ${r.videoUrl} yourself if you can render video.`)
    : r.screenshotUrl
      ? 'No recording — the screenshot is the visual evidence. View it before forming a theory.'
      : 'No visual evidence attached.'
  return {
    hasVideo: !!r.videoUrl,
    videoUrl: r.videoUrl,
    videoSeconds: r.videoSeconds,
    watchRange: r.videoTrim,
    frames,
    screenshotUrl: r.screenshotUrl,
    instruction,
  }
}

export function buildRepro(r: Report): ReproResult {
  const visual = buildVisual(r)
  const ctx = r.context as ReproBundle | null
  if (!ctx) {
    // Still hand back the visual half: a video-only report is not an empty report.
    return { kind: 'none', message: `report ${r.id} has no captured repro context (screenshot/video only).`, visual }
  }
  const steps = reproSteps(ctx)
  const errors = (ctx.console ?? []).filter((c) => c.level === 'error')
  const failed = (ctx.network ?? []).filter((n) => n.status === 0 || n.status >= 400)
  return {
    kind: 'repro',
    report: { id: r.id, note: r.note, pageUrl: r.pageUrl, status: r.status, type: r.type, severity: r.severity },
    visual,
    environment: ctx.env,
    steps: steps.length ? steps : ['(no user actions were recorded)'],
    consoleErrors: errors.map((e) => e.text),
    failedRequests: failed.map((n) => `${n.method} ${n.url} → ${n.status || 'ERR'} (${n.ms}ms)`),
  }
}
