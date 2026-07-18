import { ImageAnnotator, DEFAULT_COLORS } from '@th/core'
import type { ReproBundle } from '@th/core'
import { getConfig } from '@/lib/config'
import { buildReport } from '@/lib/report'
import { requestBundle } from '@/lib/bridge'

// The in-page overlay. Lives in a shadow root so the host site's CSS can't touch it. Background hands us a
// screenshot; we let the tester draw / crop / note, then post it (via background) to the collector.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    let open = false
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'TH_OPEN' && !open) {
        open = true
        // Snapshot the repro bundle at trigger time — BEFORE the overlay mounts — so the tester's own clicks
        // on our UI don't pollute the recorded action trail. Null on pages where the MAIN world didn't load.
        requestBundle().then((context) => mount(msg.shot as string, context, () => { open = false }))
      }
    })
  },
})

const CSS = `
:host, * { box-sizing: border-box; }
.scrim { position: fixed; inset: 0; background: rgba(3,7,18,.82); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 16px; font: 14px system-ui, sans-serif; }
.card { display: flex; flex-direction: column; gap: 10px; width: min(1100px, 96vw); max-height: 94vh; background: #131a2b; color: #e6edf7; border: 1px solid #223049; border-radius: 14px; padding: 14px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.7); }
.head { display: flex; align-items: center; gap: 10px; }
.title { font-weight: 800; }
.head .x { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; border: 1px solid #223049; background: #0f1626; color: #8ea0bd; cursor: pointer; }
.canvas { display: block; margin: 0 auto; max-width: 100%; max-height: 62vh; border-radius: 10px; border: 1px solid #223049; background: #0f1626; touch-action: none; cursor: crosshair; }
.canvas.crop { cursor: cell; }
.tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.sw.on { border-color: #e6edf7; box-shadow: 0 0 0 2px #131a2b; }
.tb { height: 32px; padding: 0 11px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.tb.on { border-color: #0a84ff; background: #0a84ff; color: #fff; }
.tb:disabled { opacity: .4; cursor: default; }
.sep { flex: 1; }
.note { width: 100%; min-height: 60px; padding: 10px 12px; background: #0f1626; border: 1px solid #223049; border-radius: 10px; color: #e6edf7; font: inherit; resize: vertical; outline: none; }
.foot { display: flex; align-items: center; gap: 10px; }
.msg { color: #8ea0bd; font-size: 12.5px; }
.msg.err { color: #ff6b6b; }
.msg.ok { color: #34d399; }
.ctxhint { margin-left: auto; font-size: 11.5px; font-weight: 700; color: #8ea0bd; display: flex; gap: 6px; align-items: center; }
.ctxhint b { color: #38bdf8; font-weight: 800; }
.ctxhint .e { color: #fda4af; }
.btn { margin-left: auto; height: 40px; padding: 0 20px; border: 0; border-radius: 10px; background: #0a84ff; color: #fff; font-weight: 800; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: default; }
.ghost { background: transparent; border: 1px solid #223049; color: #e6edf7; }
`

function mount(shot: string, context: ReproBundle | null, onClose: () => void) {
  const host = document.createElement('div')
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="scrim" part="scrim">
      <div class="card">
        <div class="head"><span class="title">🐞 Report an issue</span><span class="ctxhint"></span><button class="x" title="Close">✕</button></div>
        <canvas class="canvas"></canvas>
        <div class="tools">
          ${DEFAULT_COLORS.map((c, i) => `<button class="sw${i === 0 ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}
          <button class="tb" data-act="crop">✂ Crop</button>
          <button class="tb" data-act="uncrop" style="display:none">↶ Undo crop</button>
          <span class="sep"></span>
          <button class="tb" data-act="undo" disabled>↩ Undo</button>
        </div>
        <textarea class="note" placeholder="What's wrong here?"></textarea>
        <div class="foot">
          <span class="msg"></span>
          <button class="btn ghost cancel">Cancel</button>
          <button class="btn send">Send</button>
        </div>
      </div>
    </div>`
  document.documentElement.appendChild(host)

  const q = <T extends Element>(s: string) => root.querySelector(s) as T
  const canvas = q<HTMLCanvasElement>('.canvas')
  const note = q<HTMLTextAreaElement>('.note')
  const msg = q<HTMLElement>('.msg')
  const sendBtn = q<HTMLButtonElement>('.send')
  const cropBtn = q<HTMLButtonElement>('[data-act="crop"]')
  const uncropBtn = q<HTMLButtonElement>('[data-act="uncrop"]')
  const undoBtn = q<HTMLButtonElement>('[data-act="undo"]')

  const close = () => { host.remove(); onClose() }

  // Show the tester what technical context was captured alongside the screenshot.
  const hint = q<HTMLElement>('.ctxhint')
  if (context) {
    const errs = (context.console ?? []).filter((c) => c.level === 'error').length
    const bits: string[] = []
    if (context.actions?.length) bits.push(`<b>${context.actions.length}</b> steps`)
    if (context.console?.length) bits.push(`<b>${context.console.length}</b> console`)
    if (context.network?.length) bits.push(`<b>${context.network.length}</b> net`)
    if (errs) bits.push(`<span class="e"><b>${errs}</b> err</span>`)
    hint.innerHTML = bits.length ? '📋 ' + bits.join(' · ') + ' captured' : ''
  }

  const refresh = () => {
    undoBtn.disabled = !ann.canUndo()
    uncropBtn.style.display = ann.canUndoCrop() ? '' : 'none'
    cropBtn.classList.toggle('on', ann.tool === 'crop')
    canvas.classList.toggle('crop', ann.tool === 'crop')
  }
  const ann = new ImageAnnotator(canvas, { onChange: refresh })
  ann.setImage(shot).then(refresh).catch(() => setMsg('Could not load screenshot', 'err'))

  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ann.pointerDown(e.clientX, e.clientY) })
  canvas.addEventListener('pointermove', (e) => ann.pointerMove(e.clientX, e.clientY))
  canvas.addEventListener('pointerup', () => ann.pointerUp())
  canvas.addEventListener('pointerleave', () => ann.pointerUp())

  root.querySelectorAll('.sw').forEach((el) =>
    el.addEventListener('click', () => {
      ann.setColor((el as HTMLElement).dataset.c!)
      root.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s === el))
    }),
  )
  cropBtn.addEventListener('click', () => ann.setTool(ann.tool === 'crop' ? 'draw' : 'crop'))
  uncropBtn.addEventListener('click', () => ann.undoCrop())
  undoBtn.addEventListener('click', () => ann.undo())
  q<HTMLElement>('.x').addEventListener('click', close)
  q<HTMLElement>('.cancel').addEventListener('click', close)

  function setMsg(t: string, cls = '') { msg.textContent = t; msg.className = 'msg ' + cls }

  sendBtn.addEventListener('click', async () => {
    const cfg = await getConfig()
    const payload = buildReport({
      ingestKey: cfg.ingestKey,
      note: note.value,
      screenshot: ann.toDataURL(0.85),
      pageUrl: location.href,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      userAgent: navigator.userAgent,
      context,
    })
    if (!payload.note && !payload.screenshot) { setMsg('Add a note or a screenshot', 'err'); return }
    sendBtn.disabled = true
    setMsg('Sending…')
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TH_SEND', collectorUrl: cfg.collectorUrl, payload })
      if (res?.ok) { setMsg('Sent ✓', 'ok'); setTimeout(close, 900) }
      else { setMsg('Failed: ' + (res?.error || 'server error'), 'err'); sendBtn.disabled = false }
    } catch (e) {
      setMsg('Failed: ' + String(e), 'err'); sendBtn.disabled = false
    }
  })
}
