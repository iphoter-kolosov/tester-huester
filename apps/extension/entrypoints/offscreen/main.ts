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
  try { stream?.getTracks().forEach((t) => t.stop()) } catch {}
  stream = null
  recorder = null
}

async function stop(): Promise<{ ok: boolean; dataUrl?: string; seconds?: number; bytes?: number; error?: string }> {
  const rec = recorder
  if (!rec) return { ok: false, error: 'not recording' }
  const seconds = (Date.now() - startedAt) / 1000

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
  return { ok: !!dataUrl, dataUrl, seconds, bytes: blob.size, error: dataUrl ? undefined : 'encode failed' }
}

chrome.runtime.onMessage.addListener((msg: StartMsg | StopMsg, _sender, sendResponse) => {
  if (msg?.type === 'TH_OFF_START') { void start(msg as StartMsg).then(sendResponse); return true }
  if (msg?.type === 'TH_OFF_STOP') { void stop().then(sendResponse); return true }
  return undefined
})
