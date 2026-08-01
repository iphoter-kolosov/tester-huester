// Offscreen recorder: owns the MediaStream and the MediaRecorder for tab capture.
//
// Why this file exists: an MV3 service worker cannot hold a MediaStream, and a content script cannot obtain a
// tab-capture stream. The background gets a streamId via chrome.tabCapture.getMediaStreamId() and hands it
// here; this document turns it into a real webm video. The result is pixels — what the tester actually saw —
// instead of a DOM event log that has to be reconstructed (and, on app-heavy pages, reconstructs into an
// unrecognisable frame).

type StartMsg = { type: 'TH_OFF_START'; streamId: string; maxSeconds?: number }
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

// 2.5 Mbps at 1080p-ish is plenty for UI recordings and keeps a 2-minute clip in the tens of MB before it is
// capped; the collector rejects anything over its own limit anyway.
const BITS_PER_SECOND = 2_500_000
const HARD_CAP_S = 300

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
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
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

async function stop(): Promise<{ ok: boolean; dataUrl?: string; seconds?: number; bytes?: number; frames?: { at: number; dataUrl: string }[]; error?: string }> {
  const rec = recorder
  if (!rec) return { ok: false, error: 'not recording' }
  const seconds = (Date.now() - startedAt) / 1000
  grabFrame() // the final state is the one the tester wanted to show
  const shots = thinFrames(frames)

  const blob: Blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }))
    try { rec.stop() } catch { resolve(new Blob(chunks, { type: 'video/webm' })) }
  })
  cleanup()

  // Hand the video back as a data URL: it crosses the extension message boundary as a plain string, which is
  // the only shape that survives to the background worker without a second transport.
  const dataUrl: string = await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => resolve('')
    fr.readAsDataURL(blob)
  })
  chunks = []
  frames = []
  return { ok: !!dataUrl, dataUrl, seconds, bytes: blob.size, frames: shots, error: dataUrl ? undefined : 'encode failed' }
}

chrome.runtime.onMessage.addListener((msg: StartMsg | StopMsg, _sender, sendResponse) => {
  if (msg?.type === 'TH_OFF_START') { void start(msg as StartMsg).then(sendResponse); return true }
  if (msg?.type === 'TH_OFF_STOP') { void stop().then(sendResponse); return true }
  return undefined
})
