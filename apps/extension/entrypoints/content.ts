import { ImageAnnotator, DEFAULT_COLORS } from '@th/core'
import type { ReproBundle, Tool, Width } from '@th/core'
import { getConfig } from '@/lib/config'
import { buildReport, type ReportType, type Severity } from '@/lib/report'
import { requestBundle } from '@/lib/bridge'
import { startReplay, snapshotReplay, REPLAY_BLOCK_CLASS, type RREvent } from '@/lib/replay'

// The in-page overlay. Lives in a shadow root so the host site's CSS can't touch it. Background hands us a
// screenshot; we let the tester draw / annotate / note, then post it (via background) to the collector.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Idempotent load guard: the declarative injection and the background warm-up / on-demand injection can
    // both target the same frame (they share this isolated-world global). Run the setup exactly once so we
    // never end up with two rrweb recorders or two overlay listeners.
    const g = globalThis as unknown as { __thLoaded?: boolean }
    if (g.__thLoaded) return
    g.__thLoaded = true

    // Start buffering the last ~2 min of DOM replay immediately (opt-out via popup). Runs in the isolated
    // world but observes the shared DOM, which is all rrweb needs.
    getConfig().then((c) => { if (c.recordReplay) startReplay() }).catch(() => {})

    let open = false
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'TH_OPEN' && !open) {
        open = true
        // Snapshot repro bundle AND replay at trigger time — BEFORE the overlay mounts — so the tester's own
        // clicks on our UI don't pollute the trail/replay. Bundle is null where the MAIN world didn't load.
        const replay = snapshotReplay()
        requestBundle().then((context) => mount(msg.shot as string, context, replay, () => { open = false }))
      }
    })
  },
})

// Report kinds, each with its own label + icon; the overlay title reflects the current selection.
const TYPES: { value: ReportType; label: string; icon: string }[] = [
  { value: 'feature', label: 'Фича', icon: '💡' },
  { value: 'bug', label: 'Баг', icon: '🐞' },
  { value: 'fix', label: 'Правка', icon: '✏️' },
  { value: 'text', label: 'Текст', icon: '📝' },
]
const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'med', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'crit', label: 'crit' },
]
const WIDTHS: { value: Width; label: string }[] = [
  { value: 'thin', label: 'Тонкая' },
  { value: 'med', label: 'Средняя' },
  { value: 'thick', label: 'Толстая' },
]

const CSS = `
:host, * { box-sizing: border-box; }
.scrim { position: fixed; inset: 0; background: rgba(3,7,18,.82); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 16px; font: 14px system-ui, sans-serif; }
.card { position: relative; display: flex; flex-direction: column; gap: 10px; width: 98vw; max-width: 98vw; max-height: 96vh; background: #131a2b; color: #e6edf7; border: 1px solid #223049; border-radius: 14px; padding: 14px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.7); }
.head { display: flex; align-items: center; gap: 10px; }
.title { font-weight: 800; }
.head .x { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; border: 1px solid #223049; background: #0f1626; color: #8ea0bd; cursor: pointer; }
.canvas { display: block; margin: 0 auto; max-width: 100%; max-height: 74vh; border-radius: 10px; border: 1px solid #223049; background: #0f1626; touch-action: none; cursor: crosshair; }
.canvas.crop { cursor: cell; }
.canvas.text { cursor: text; }
.canvas.eraser { cursor: pointer; }
.tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.sw.on { border-color: #e6edf7; box-shadow: 0 0 0 2px #131a2b; }
.tb { height: 32px; padding: 0 11px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.tb.on { border-color: #0a84ff; background: #0a84ff; color: #fff; }
.tb:disabled { opacity: .4; cursor: default; }
.vsep { width: 1px; align-self: stretch; background: #223049; margin: 2px 3px; }
.sep { flex: 1; }
.meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.meta label { font-size: 11.5px; font-weight: 800; color: #8ea0bd; text-transform: uppercase; letter-spacing: .04em; }
.seg { display: inline-flex; border: 1px solid #223049; border-radius: 8px; overflow: hidden; }
.seg button { height: 30px; padding: 0 11px; border: 0; border-right: 1px solid #223049; background: #0f1626; color: #e6edf7; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.seg button:last-child { border-right: 0; }
.seg button.on { background: #0a84ff; color: #fff; }
.seg.sev button.on[data-v="low"] { background: #3f6212; }
.seg.sev button.on[data-v="med"] { background: #a16207; }
.seg.sev button.on[data-v="high"] { background: #c2410c; }
.seg.sev button.on[data-v="crit"] { background: #b91c1c; }
.psel { height: 30px; padding: 0 9px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer; max-width: 190px; }
.psel:hover { border-color: #38bdf8; }
.khint { margin-left: auto; font-size: 11px; font-weight: 700; color: #8ea0bd; }
.khint b { color: #38bdf8; font-weight: 800; }
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
.tin { position: fixed; z-index: 12; display: none; flex-direction: column; gap: 6px; padding: 8px; background: #0f1626; border: 1px solid #0a84ff; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.6); }
.tin input { width: 260px; height: 32px; padding: 0 10px; background: #131a2b; border: 1px solid #223049; border-radius: 7px; outline: none; color: #e6edf7; font: 800 15px system-ui, sans-serif; }
.tinrow { display: flex; align-items: center; gap: 6px; }
.tinsz { display: inline-flex; gap: 4px; }
.tinsz button { width: 26px; height: 24px; border: 1px solid #223049; background: #131a2b; color: #e6edf7; border-radius: 6px; font-weight: 800; font-size: 12px; cursor: pointer; }
.tinsz button.on { border-color: #0a84ff; background: #0a84ff; color: #fff; }
.tinhint { margin-left: auto; font-size: 11px; color: #8ea0bd; font-weight: 700; white-space: nowrap; }
.tinhint b { color: #38bdf8; }
.tmark { position: fixed; z-index: 11; display: none; width: 12px; height: 12px; margin: -6px 0 0 -6px; pointer-events: none; border: 2px solid #0a84ff; border-radius: 50%; box-shadow: 0 0 0 2px rgba(3,7,18,.6); }
`

function mount(shot: string, context: ReproBundle | null, replay: RREvent[], onClose: () => void) {
  const host = document.createElement('div')
  host.className = REPLAY_BLOCK_CLASS // keep our own overlay out of any ongoing replay recording
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="scrim" part="scrim">
      <div class="card">
        <div class="head"><span class="title"></span><span class="ctxhint"></span><button class="x" title="Close">✕</button></div>
        <canvas class="canvas"></canvas>
        <div class="tools">
          ${DEFAULT_COLORS.map((c, i) => `<button class="sw${i === 0 ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}
          <span class="vsep"></span>
          <button class="tb tool on" data-tool="draw" title="Карандаш (P)">✏</button>
          <button class="tb tool" data-tool="arrow" title="Стрелка (A)">↗</button>
          <button class="tb tool" data-tool="rect" title="Прямоугольник (R)">▭</button>
          <button class="tb tool" data-tool="text" title="Текст (T)">T</button>
          <button class="tb tool" data-tool="eraser" title="Ластик (E)">⌫</button>
          <span class="vsep"></span>
          ${WIDTHS.map((w) => `<button class="tb width${w.value === 'med' ? ' on' : ''}" data-w="${w.value}" title="${w.label} (${w.value === 'thin' ? '1' : w.value === 'med' ? '2' : '3'})">${w.value === 'thin' ? '│' : w.value === 'med' ? '┃' : '█'}</button>`).join('')}
          <span class="vsep"></span>
          <button class="tb tool" data-tool="crop" title="Кадрировать (C)">✂</button>
          <span class="sep"></span>
          <button class="tb" data-act="undo" disabled title="Отменить (Ctrl+Z)">↩ Undo</button>
          <button class="tb" data-act="redo" disabled title="Повторить (Ctrl+Y / Ctrl+Shift+Z)">↪ Redo</button>
          <button class="tb" data-act="clear" disabled title="Очистить (Shift+Del)">🗑 Очистить</button>
        </div>
        <div class="meta">
          <label>Тип</label>
          <div class="seg type">
            ${TYPES.map((t) => `<button data-v="${t.value}"${t.value === 'bug' ? ' class="on"' : ''}>${t.icon} ${t.label}</button>`).join('')}
          </div>
          <label>Важность</label>
          <div class="seg sev">
            ${SEVERITIES.map((s) => `<button data-v="${s.value}"${s.value === 'med' ? ' class="on"' : ''}>${s.label}</button>`).join('')}
          </div>
          <label>Проект</label>
          <select class="psel"><option value="">по умолчанию</option></select>
          <span class="khint"><b>Ctrl+Enter</b> отправить · <b>Esc</b> закрыть</span>
        </div>
        <textarea class="note" placeholder="What's wrong here?"></textarea>
        <div class="foot">
          <span class="msg"></span>
          <button class="btn ghost cancel">Cancel</button>
          <button class="btn send">Send</button>
        </div>
      </div>
      <div class="tmark"></div>
      <div class="tin">
        <input type="text" placeholder="Текст…" />
        <div class="tinrow">
          <span class="tinsz">
            <button data-tsz="thin">S</button>
            <button data-tsz="med" class="on">M</button>
            <button data-tsz="thick">L</button>
          </span>
          <span class="tinhint"><b>&#8629;</b> поставить &#183; <b>Esc</b> отмена</span>
        </div>
      </div>
    </div>`
  document.documentElement.appendChild(host)

  const q = <T extends Element>(s: string) => root.querySelector(s) as T
  const canvas = q<HTMLCanvasElement>('.canvas')
  const note = q<HTMLTextAreaElement>('.note')
  const msg = q<HTMLElement>('.msg')
  const titleEl = q<HTMLElement>('.title')
  const sendBtn = q<HTMLButtonElement>('.send')
  const undoBtn = q<HTMLButtonElement>('[data-act="undo"]')
  const redoBtn = q<HTMLButtonElement>('[data-act="redo"]')
  const clearBtn = q<HTMLButtonElement>('[data-act="clear"]')
  const tin = q<HTMLElement>('.tin')
  const tinInput = q<HTMLInputElement>('.tin input')
  const tmark = q<HTMLElement>('.tmark')
  const psel = q<HTMLSelectElement>('.psel')

  // Form state (shared with track A via the exact field names note/type/severity).
  let type: ReportType = 'bug'
  let severity: Severity = 'med'
  let projectId: string | null = null // chosen in the project picker; null → route by the ingest key
  let pendingText: { x: number; y: number } | null = null

  const close = () => { document.removeEventListener('keydown', onKey, true); host.remove(); onClose() }

  // Standard editor hotkeys across the whole overlay. Single-key shortcuts are skipped while typing in a field
  // so text entry is unaffected; the undo/redo/crop stack is the annotator's unified one (drawings AND crop).
  const TOOL_KEYS: Record<string, Tool> = { p: 'draw', a: 'arrow', r: 'rect', t: 'text', e: 'eraser', c: 'crop' }
  const WIDTH_KEYS: Record<string, Width> = { '1': 'thin', '2': 'med', '3': 'thick' }
  function onKey(e: KeyboardEvent) {
    const ae = root.activeElement as HTMLElement | null
    const typing = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()

    if (mod && e.key === 'Enter') { e.preventDefault(); sendBtn.click(); return } // send from anywhere
    if (mod && k === 'z') { if (typing) return; e.preventDefault(); if (e.shiftKey) ann.redo(); else ann.undo(); return }
    if (mod && k === 'y') { if (typing) return; e.preventDefault(); ann.redo(); return } // Ctrl+Y = redo
    if (mod) return // leave other Ctrl/Cmd combos to the browser

    if (e.key === 'Escape') { if (typing) return; e.preventDefault(); close(); return }
    if (typing) return

    if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); ann.clearAll(); return }
    const tool = TOOL_KEYS[k]
    if (tool) { e.preventDefault(); ann.setTool(tool); refresh(); return }
    const w = WIDTH_KEYS[k]
    if (w) {
      e.preventDefault()
      ann.setWidth(w)
      root.querySelectorAll('.tb.width').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.w === w))
    }
  }
  document.addEventListener('keydown', onKey, true)

  const syncTitle = () => {
    const t = TYPES.find((x) => x.value === type)!
    titleEl.textContent = `${t.icon} ${t.label} — сообщить`
  }
  syncTitle()

  // Show the tester what technical context was captured alongside the screenshot.
  const hint = q<HTMLElement>('.ctxhint')
  const bits: string[] = []
  if (context) {
    const errs = (context.console ?? []).filter((c) => c.level === 'error').length
    if (context.actions?.length) bits.push(`<b>${context.actions.length}</b> steps`)
    if (context.console?.length) bits.push(`<b>${context.console.length}</b> console`)
    if (context.network?.length) bits.push(`<b>${context.network.length}</b> net`)
    if (errs) bits.push(`<span class="e"><b>${errs}</b> err</span>`)
  }
  if (replay.length) bits.push(`<b>▶</b> replay`)
  hint.innerHTML = bits.length ? '📋 ' + bits.join(' · ') + ' captured' : ''

  const refresh = () => {
    undoBtn.disabled = !ann.canUndo()
    redoBtn.disabled = !ann.canRedo()
    clearBtn.disabled = !ann.canClear()
    root.querySelectorAll('.tb.tool').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tool === ann.tool))
    canvas.classList.toggle('crop', ann.tool === 'crop')
    canvas.classList.toggle('text', ann.tool === 'text')
    canvas.classList.toggle('eraser', ann.tool === 'eraser')
  }

  const openTextInput = (clientX: number, clientY: number) => {
    pendingText = { x: clientX, y: clientY }
    tin.style.left = Math.min(clientX, window.innerWidth - 300) + 'px'
    tin.style.top = Math.min(clientY + 10, window.innerHeight - 92) + 'px'
    tin.style.display = 'flex'
    // A caret dot marks exactly where the text will anchor on the image.
    tmark.style.left = clientX + 'px'; tmark.style.top = clientY + 'px'; tmark.style.display = 'block'
    tinInput.value = ''
    // Defer focus past the current pointer event — focusing during pointerdown (esp. with capture) is flaky.
    setTimeout(() => { tinInput.focus(); tinInput.select() }, 0)
  }
  const hideTextInput = () => { tin.style.display = 'none'; tmark.style.display = 'none' }
  const commitTextInput = () => {
    const s = tinInput.value
    hideTextInput()
    if (pendingText && s.trim()) ann.addText(pendingText.x, pendingText.y, s)
    pendingText = null
  }
  const cancelTextInput = () => { hideTextInput(); pendingText = null }

  const ann = new ImageAnnotator(canvas, { onChange: refresh, onTextRequest: openTextInput })
  ann.setImage(shot).then(refresh).catch(() => setMsg('Could not load screenshot', 'err'))

  canvas.addEventListener('pointerdown', (e) => {
    // Text & eraser are single-click actions — capturing the pointer here would steal focus from the text input.
    if (ann.tool !== 'text' && ann.tool !== 'eraser') canvas.setPointerCapture(e.pointerId)
    ann.pointerDown(e.clientX, e.clientY)
  })
  canvas.addEventListener('pointermove', (e) => ann.pointerMove(e.clientX, e.clientY))
  canvas.addEventListener('pointerup', () => ann.pointerUp())
  canvas.addEventListener('pointerleave', () => ann.pointerUp())

  tinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTextInput() }
    else if (e.key === 'Escape') { e.preventDefault(); cancelTextInput() }
  })
  tinInput.addEventListener('blur', commitTextInput)

  root.querySelectorAll('.sw').forEach((el) =>
    el.addEventListener('click', () => {
      ann.setColor((el as HTMLElement).dataset.c!)
      root.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s === el))
    }),
  )
  root.querySelectorAll('.tb.tool').forEach((el) =>
    el.addEventListener('click', () => ann.setTool((el as HTMLElement).dataset.tool as Tool)),
  )
  root.querySelectorAll('.tb.width').forEach((el) =>
    el.addEventListener('click', () => {
      ann.setWidth((el as HTMLElement).dataset.w as Width)
      root.querySelectorAll('.tb.width').forEach((w) => w.classList.toggle('on', w === el))
    }),
  )
  root.querySelectorAll('.seg.type button').forEach((el) =>
    el.addEventListener('click', () => {
      type = (el as HTMLElement).dataset.v as ReportType
      root.querySelectorAll('.seg.type button').forEach((b) => b.classList.toggle('on', b === el))
      syncTitle()
    }),
  )
  root.querySelectorAll('.seg.sev button').forEach((el) =>
    el.addEventListener('click', () => {
      severity = (el as HTMLElement).dataset.v as Severity
      root.querySelectorAll('.seg.sev button').forEach((b) => b.classList.toggle('on', b === el))
    }),
  )
  root.querySelectorAll('.tinsz button').forEach((el) => {
    el.addEventListener('mousedown', (e) => e.preventDefault()) // keep the text input focused when picking a size
    el.addEventListener('click', () => {
      ann.setTextSize((el as HTMLElement).dataset.tsz as Width)
      root.querySelectorAll('.tinsz button').forEach((b) => b.classList.toggle('on', b === el))
    })
  })
  undoBtn.addEventListener('click', () => ann.undo())
  redoBtn.addEventListener('click', () => ann.redo())
  clearBtn.addEventListener('click', () => ann.clearAll())
  q<HTMLElement>('.x').addEventListener('click', close)
  q<HTMLElement>('.cancel').addEventListener('click', close)

  // Populate the project picker from the account's projects (fetched via background → collector), preselecting
  // the ingest key's own project. Choosing another routes the report there on send.
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  getConfig()
    .then((cfg) => chrome.runtime.sendMessage({ type: 'TH_PROJECTS', collectorUrl: cfg.collectorUrl, ingestKey: cfg.ingestKey }))
    .then((res: { ok?: boolean; projects?: { id: string; name: string }[]; defaultId?: string }) => {
      if (!res?.ok || !Array.isArray(res.projects) || !res.projects.length) return
      projectId = res.defaultId || res.projects[0]!.id
      psel.innerHTML = res.projects.map((p) => `<option value="${esc(p.id)}"${p.id === projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
    })
    .catch(() => {})
  psel.addEventListener('change', () => { projectId = psel.value || null })

  function setMsg(t: string, cls = '') { msg.textContent = t; msg.className = 'msg ' + cls }

  sendBtn.addEventListener('click', async () => {
    const cfg = await getConfig()
    const payload = buildReport({
      ingestKey: cfg.ingestKey,
      note: note.value,
      type,
      severity,
      // JPEG by default keeps full-page screenshots small; core also exposes a PNG option (toDataURL(q,
      // 'image/png') / toPNG()) for crisp line/dark-palette annotations when payload size isn't a concern.
      screenshot: ann.toDataURL(0.85),
      pageUrl: location.href,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      userAgent: navigator.userAgent,
      context,
      projectId,
    })
    if (!payload.note && !payload.screenshot) { setMsg('Add a note or a screenshot', 'err'); return }
    sendBtn.disabled = true
    setMsg('Sending…')
    try {
      // Replay events ride alongside the report (they're large → the collector stores them as a blob, not
      // in the report row). Cap serialized size so a churn-heavy page can't produce a monster payload.
      const replayPayload = replay.length && JSON.stringify(replay).length < 4_000_000 ? replay : undefined
      const res = await chrome.runtime.sendMessage({ type: 'TH_SEND', collectorUrl: cfg.collectorUrl, payload: { ...payload, replay: replayPayload } })
      if (res?.ok) { setMsg('Sent ✓', 'ok'); setTimeout(close, 900) }
      else { setMsg('Failed: ' + (res?.error || 'server error'), 'err'); sendBtn.disabled = false }
    } catch (e) {
      setMsg('Failed: ' + String(e), 'err'); sendBtn.disabled = false
    }
  })
}
