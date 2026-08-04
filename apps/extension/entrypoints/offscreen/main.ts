// Offscreen recorder: owns the MediaStream and the MediaRecorder for tab capture.
//
// Why this file exists: an MV3 service worker cannot hold a MediaStream, and a content script cannot obtain a
// tab-capture stream. The background gets a streamId via chrome.tabCapture.getMediaStreamId() and hands it
// here; this document turns it into a real webm video. The result is pixels — what the tester actually saw —
// instead of a DOM event log that has to be reconstructed (and, on app-heavy pages, reconstructs into an
// unrecognisable frame).

type StartMsg = { type: 'TH_OFF_START'; streamId: string; maxSeconds?: number; collectorUrl: string }
type StopMsg = { type: 'TH_OFF_STOP' }

let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let startedAt = 0
let stopTimer: ReturnType<typeof setTimeout> | null = null

// Frames sampled from the same stream while recording. An AI agent cannot watch a webm — models read text and
// images — so a video alone is useful to the human and opaque to the agent that has to fix the bug. Sampling
// here is free (the stream is already decoded) and each frame carries its timestamp, so the agent gets an
// ordered visual story it can actually look at.
const FRAME_EVERY_MS = 2000
const MAX_FRAMES = 8
const FRAME_WIDTH = 960
let frames: { at: number; dataUrl: string }[] = []
let frameVideo: HTMLVideoElement | null = null
let frameTimer: ReturnType<typeof setInterval> | null = null

function grabFrame(): void {
  const v = frameVideo
  if (!v || !v.videoWidth) return
  const scale = Math.min(1, FRAME_WIDTH / v.videoWidth)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(v.videoWidth * scale))
  c.height = Math.max(1, Math.round(v.videoHeight * scale))
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.drawImage(v, 0, 0, c.width, c.height)
  frames.push({ at: (Date.now() - startedAt) / 1000, dataUrl: c.toDataURL('image/jpeg', 0.62) })
}

// Keep the story, not every tick: thin an over-long run down to evenly spaced frames, always keeping the
// first and the last (where a bug usually shows).
function thinFrames(list: { at: number; dataUrl: string }[], max = MAX_FRAMES) {
  if (list.length <= max) return list
  const out = [list[0]!]
  const step = (list.length - 1) / (max - 1)
  for (let i = 1; i < max - 1; i++) out.push(list[Math.round(i * step)]!)
  out.push(list[list.length - 1]!)
  return out
}

// UI recordings compress well; 1.2 Mbps stays legible for a dashboard and keeps a 5-minute clip well under the
// collector's 40 MB cap (≈ 9 MB/min). A dedicated smoke-test at 2.5 Mbps hit 19 MB/min which blew MV3's
// 64 MiB sendMessage limit — the messaging path is gone now (offscreen uploads directly), but a lower bitrate
// still saves bandwidth and disk with no visible loss for UI capture.
const BITS_PER_SECOND = 1_200_000
const HARD_CAP_S = 300
// Own record of running size, so we can stop early instead of letting MediaRecorder blow past the collector cap.
let totalBytes = 0
const SIZE_CAP_BYTES = 38 * 1024 * 1024 // slightly under the server's 40 MB limit — leave headroom for the last chunk
let collectorUrl = ''
let stoppedByCap = false

function pickMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m
  return ''
}

async function start(msg: StartMsg): Promise<{ ok: boolean; error?: string }> {
  if (recorder) return { ok: false, error: 'already recording' }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Chrome-specific constraints for tab capture; the cast keeps TS out of the way.
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
    } as unknown as MediaStreamConstraints)

    const mimeType = pickMime()
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: BITS_PER_SECOND } : undefined)
    chunks = []
    totalBytes = 0
    stoppedByCap = false
    collectorUrl = msg.collectorUrl
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return
      chunks.push(e.data)
      totalBytes += e.data.size
      // Stop cleanly the moment we approach the collector's cap. Better a clean 38 MB clip than a broken 50 MB
      // one the server would refuse and the tester would have to redo.
      if (totalBytes >= SIZE_CAP_BYTES && !stoppedByCap && recorder && recorder.state === 'recording') {
        stoppedByCap = true
        try { recorder.stop() } catch {}
      }
    }
    recorder.start(1000) // emit a chunk per second so a crash still leaves usable footage
    startedAt = Date.now()

    // Sample frames off the same stream for the agent.
    frames = []
    frameVideo = document.createElement('video')
    frameVideo.muted = true
    frameVideo.playsInline = true
    frameVideo.srcObject = stream
    await frameVideo.play().catch(() => {})
    grabFrame() // the opening state matters
    frameTimer = setInterval(grabFrame, FRAME_EVERY_MS)

    // Never let a forgotten recording run forever.
    const cap = Math.min(msg.maxSeconds ?? HARD_CAP_S, HARD_CAP_S)
    stopTimer = setTimeout(() => { void stop() }, cap * 1000)
    return { ok: true }
  } catch (e) {
    cleanup()
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

function cleanup(): void {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
  if (frameTimer) { clearInterval(frameTimer); frameTimer = null }
  try { frameVideo?.pause() } catch {}
  frameVideo = null
  try { stream?.getTracks().forEach((t) => t.stop()) } catch {}
  stream = null
  recorder = null
}

async function stop(): Promise<{ ok: boolean; url?: string; seconds?: number; bytes?: number; capped?: boolean; frames?: { at: number; dataUrl: string }[]; error?: string }> {
  const rec = recorder
  if (!rec) return { ok: false, error: 'not recording' }
  const seconds = (Date.now() - startedAt) / 1000
  grabFrame() // the final state is the one the tester wanted to show
  const shots = thinFrames(frames)

  const blob: Blob = await new Promise((resolve) => {
    if (rec.state === 'inactive') {
      resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }))
      return
    }
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }))
    try { rec.stop() } catch { resolve(new Blob(chunks, { type: 'video/webm' })) }
  })
  const wasCapped = stoppedByCap
  const dest = collectorUrl
  cleanup()

  if (!blob.size) return { ok: false, error: 'empty recording' }

  // Upload the video BINARY directly from this offscreen page — it has fetch() and the extension's origin, and
  // /api/upload/video is CORS-open. This bypasses MV3's 64 MiB sendMessage cap entirely: nothing large ever
  // crosses the extension message boundary. Only the tiny returned URL does.
  try {
    const res = await fetch(dest.replace(/\/+$/, '') + '/api/upload/video', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'video/webm' },
      body: blob,
    })
    const j = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null
    chunks = []
    frames = []
    if (!res.ok || !j?.ok || !j.url) {
      return { ok: false, error: j?.error || `HTTP ${res.status}`, bytes: blob.size, capped: wasCapped, frames: shots }
    }
    return { ok: true, url: j.url, seconds, bytes: blob.size, capped: wasCapped, frames: shots }
  } catch (e) {
    chunks = []
    frames = []
    return { ok: false, error: 'network: ' + String((e as Error)?.message || e), bytes: blob.size, capped: wasCapped, frames: shots }
  }
}

chrome.runtime.onMessage.addListener((msg: StartMsg | StopMsg, _sender, sendResponse) => {
  if (msg?.type === 'TH_OFF_START') { void start(msg as StartMsg).then(sendResponse); return true }
  if (msg?.type === 'TH_OFF_STOP') { void stop().then(sendResponse); return true }
  return undefined
})
