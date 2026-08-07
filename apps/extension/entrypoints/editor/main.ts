// The standalone editor window.
//
// Why it exists: the in-page overlay lives inside the site under test, and the site under test is a dev server
// that reloads on every save. The draft store (lib/draft.ts) makes that survivable, but survivable is not the
// same as undisturbed — a tester composing a long report gets their canvas yanked out from under them every
// few seconds. This window is NOT part of the page: nothing that happens to the site can reach it.
//
// Everything here autosaves into the SAME per-origin draft as the overlay, so work moves both ways: the
// overlay's "⇗ Открыть в окне" hands over mid-report, and closing this window (deliberately, accidentally, or
// through a crash) leaves the draft exactly where it was.
import { ImageAnnotator, DEFAULT_COLORS } from '@th/core'
import type { Prim, ReproBundle, Tool, Width } from '@th/core'
import { getConfig, setConfig } from '@/lib/config'
import { buildReport, type ReportType, type Severity } from '@/lib/report'
import {
  loadDraft, saveDraft, flushDrafts, clearDraft, hasContent,
  type Draft, type DraftAttachment, type DraftVideo,
} from '@/lib/draft'
import { ICON_RECT, ICON_ARROW, ICON_ELLIPSE, ICON_PENCIL, ICON_CROP, ICON_TEXT, ICON_ERASER, TOOL_CURSORS, TOOL_LABELS } from '@/lib/glyphs'

// The collector stores at most this many attachments per report (MAX_ATTACHMENTS in @th/db). Refusing the
// eleventh here, out loud, beats letting the tester annotate one the server would silently drop.
const MAX_ATTACHMENTS = 10
// /api/upload/image refuses anything above 12 MB. We normalise well below that; the check stays so an
// oversized image falls back to the inline path instead of failing the whole send.
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024
// Images larger than this are downscaled and recompressed. A pasted 4K PNG is ~8 MB of base64 in the draft,
// and ten of them would turn every autosave into a multi-second write.
const NORMALIZE_ABOVE_BYTES = 900_000
const MAX_IMAGE_EDGE = 2560
const STORE_QUALITY = 0.9 // higher than the export quality on purpose: this copy is re-encoded once more
const EXPORT_QUALITY = 0.9
const REC_MAX_SECONDS = 300
// Where the background leaves a freshly captured frame for a window that may not have loaded yet.
const SEED_KEY = 'th.editorSeed'

type Seed = { shot: string; tabId: number | null; origin: string; pageUrl: string; at: number }

// One entry per image in the strip. items[0] is the report's main screenshot; items[1..] are its attachments
// in the order the reader will see them numbered. `base` is the backdrop WITHOUT markup and `prims` is the
// markup, split for the same reason the draft splits them: a crop replaces the backdrop.
type Item = { id: string; base: string; prims: Prim[]; caption: string }

const TYPES: { value: ReportType; label: string; icon: string }[] = [
  { value: 'feature', label: 'Фича', icon: '💡' },
  { value: 'bug', label: 'Баг', icon: '🐞' },
  { value: 'fix', label: 'Правка', icon: '✏️' },
  { value: 'text', label: 'Текст', icon: '📝' },
]
const SEVERITIES: Severity[] = ['low', 'med', 'high', 'crit']
const TOOL_ICONS: { tool: Tool; icon: string }[] = [
  { tool: 'rect', icon: ICON_RECT },
  { tool: 'arrow', icon: ICON_ARROW },
  { tool: 'ellipse', icon: ICON_ELLIPSE },
  { tool: 'draw', icon: ICON_PENCIL },
  { tool: 'crop', icon: ICON_CROP },
  { tool: 'text', icon: ICON_TEXT },
  { tool: 'eraser', icon: ICON_ERASER },
]
// Mnemonic letters keyed off e.code (the PHYSICAL key), so they work under any keyboard layout — the same
// "designer" mapping the overlay ships, mirrored here so muscle memory carries across the two surfaces.
const TOOL_CODES: Record<string, Tool> = { KeyR: 'rect', KeyA: 'arrow', KeyO: 'ellipse', KeyP: 'draw', KeyC: 'crop', KeyT: 'text', KeyE: 'eraser' }
const WIDTH_CODES: Record<string, Width> = { Digit1: 'thin', Digit2: 'med', Digit3: 'thick', Numpad1: 'thin', Numpad2: 'med', Numpad3: 'thick' }

const q = <T extends Element>(s: string): T => document.querySelector(s) as T
const canvas = q<HTMLCanvasElement>('.canvas')
const noimg = q<HTMLElement>('.noimg')
const strip = q<HTMLElement>('.strip')
const cntEl = q<HTMLElement>('.cnt')
const note = q<HTMLTextAreaElement>('.note')
const capWrap = q<HTMLElement>('.capwrap')
const capIn = q<HTMLInputElement>('.capin')
const msgEl = q<HTMLElement>('.msg')
const titleEl = q<HTMLElement>('.title')
const targetEl = q<HTMLElement>('.target')
const ctxHint = q<HTMLElement>('.ctxhint')
const recSt = q<HTMLElement>('.recst')
const restBar = q<HTMLElement>('.rest')
const restT = q<HTMLElement>('.restt')
const toolsRow = q<HTMLElement>('.tools')
const typeSeg = q<HTMLElement>('.seg.type')
const sevSeg = q<HTMLElement>('.seg.sev')
const psel = q<HTMLSelectElement>('.psel')
const recBtn = q<HTMLButtonElement>('.rec')
const vdropBtn = q<HTMLButtonElement>('.vdrop')
const vidSt = q<HTMLElement>('.vidst')
const sendBtn = q<HTMLButtonElement>('.send')
const discardBtn = q<HTMLButtonElement>('.discard')
const fileIn = q<HTMLInputElement>('.filein')
const dropEl = q<HTMLElement>('.drop')
const tcur = q<HTMLElement>('.tcur')
const tin = q<HTMLElement>('.tin')
const tinInput = q<HTMLInputElement>('.tin input')
const tmark = q<HTMLElement>('.tmark')
const cbar = q<HTMLElement>('.cbar')
const cknob = q<HTMLElement>('.cknob')
const wbar = q<HTMLElement>('.wbar')
const wknob = q<HTMLElement>('.wknob')

const params = new URLSearchParams(location.search)
let targetTabId: number | null = Number(params.get('tab')) || null
const origin = params.get('origin') ?? ''
let pageUrl = params.get('url') ?? ''

let items: Item[] = [{ id: 'main', base: '', prims: [], caption: '' }]
let sel = 0
let activeDims = '' // canvas size of the selected item — the only outside signal that a crop replaced its base
let type: ReportType = 'bug'
let severity: Severity = 'med'
let projectId: string | null = null
let video: DraftVideo | null = null
let context: ReproBundle | null = null
// True while an item is being put on screen: the annotator fires onChange during that, and autosaving
// mid-restore would write an empty markup stack over the one being restored.
let hydrating = true
// Set once the draft has been deliberately discarded or successfully sent. Nothing may resurrect it after.
let draftDead = false
let sending = false
let pendingText: { x: number; y: number } | null = null
// Resolves once the window has decided what it holds (restored draft + captured frame). Everything that adds
// an image waits on it. It is released as soon as items[0] is settled — before boot's own seed handling, which
// goes through addImage and would otherwise wait on itself.
let markBooted: () => void = () => {}
const booted: Promise<void> = new Promise<void>((r) => { markBooted = r })

const uid = (): string => 'a' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
const fmtT = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function setMsg(t: string, cls = ''): void {
  msgEl.textContent = t
  msgEl.className = 'msg ' + cls
}
function setMsgHtml(html: string, cls = ''): void {
  msgEl.innerHTML = html
  msgEl.className = 'msg ' + cls
}

// ── persistence ──────────────────────────────────────────────────────────────────────────────────────────
// Everything in this window is written into the origin's draft. The window is durable; the machine it runs on
// is not. A crash, a forced extension reload or a stray ✕ must all cost nothing.
function toDraftAttachments(): DraftAttachment[] {
  return items.slice(1).map((it) => ({ id: it.id, base: it.base, prims: it.prims as unknown[], caption: it.caption }))
}

function persist(patch: Partial<Draft> = {}, immediate = true): void {
  if (draftDead || !origin) return
  syncActiveItem()
  const main = items[0]!
  const write = saveDraft(origin, {
    pageUrl,
    open: false, // the work lives in this window now; the page must not pop its own overlay on the next load
    note: note.value,
    type,
    severity,
    projectId,
    shot: main.base ? { dataUrl: main.base } : null,
    prims: main.prims as unknown[],
    attachments: toDraftAttachments(),
    video,
    context: context ?? null,
    ...patch,
  })
  // A draft that failed to save is worse than no draft — the tester would keep working believing they are
  // covered. Say it out loud instead.
  write.catch((e: unknown) => setMsg('⚠ Черновик не сохранён: ' + String(e), 'warn'))
  if (immediate) void flushDrafts()
}

// Copy the annotator's live state back into the selected item. The base image is only re-read when the canvas
// changed size, because that is the one thing a crop does — re-encoding the JPEG on every stroke would degrade
// the picture a little more each time.
function syncActiveItem(): void {
  const it = items[sel]
  if (!it || hydrating || !it.base) return
  it.prims = ann.getPrims()
  const dims = `${canvas.width}x${canvas.height}`
  if (dims !== activeDims) {
    activeDims = dims
    it.base = ann.toBaseDataURL(STORE_QUALITY)
  }
}

// ── image intake ─────────────────────────────────────────────────────────────────────────────────────────
function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('image decode failed'))
    im.src = dataUrl
  })
}

// Bound what one attachment costs in storage and on the wire. Small images are kept byte for byte, so a crisp
// PNG of a dialog stays crisp; only genuinely large captures are downscaled and re-encoded.
async function normalizeImage(dataUrl: string): Promise<string> {
  if (dataUrl.length < NORMALIZE_ABOVE_BYTES) return dataUrl
  const im = await decode(dataUrl)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(im.naturalWidth, im.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(im.naturalWidth * scale))
  c.height = Math.max(1, Math.round(im.naturalHeight * scale))
  c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', STORE_QUALITY)
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('file read failed'))
    r.readAsDataURL(f)
  })
}

// The single door every image comes through: paste, drop, file picker, "Снять кадр", the frame captured by the
// shortcut. Returns false when the image was refused, having already said why.
async function addImage(dataUrl: string, caption = ''): Promise<boolean> {
  // Nothing may enter the strip until boot has decided what the strip IS. An image arriving in the window's
  // first moments would otherwise find items[0] still empty and install itself as the main frame — the one
  // the captured screenshot was on its way to occupy.
  await booted
  let norm: string
  try {
    norm = await normalizeImage(dataUrl)
  } catch (e) {
    setMsg('Картинка не читается: ' + String(e), 'err')
    return false
  }
  // No main frame yet (the shortcut fired on a page Chrome refuses to photograph): the first image the tester
  // brings in becomes the report's screenshot rather than an attachment to nothing.
  if (!items[0]!.base) {
    syncActiveItem() // save what is on screen now, while the model still matches the annotator
    items[0]!.base = norm
    // …and then stop select() from writing that same (empty) annotator back over the frame just assigned.
    // Any code that changes an item's picture from outside the annotator has to do this.
    hydrating = true
    await select(0)
    persist()
    setMsg('Кадр загружен ✓', 'ok')
    return true
  }
  if (items.length - 1 >= MAX_ATTACHMENTS) {
    setMsg(`Вложений уже ${MAX_ATTACHMENTS} — больше сервер не примет. Удалите лишнее.`, 'warn')
    return false
  }
  items.push({ id: uid(), base: norm, prims: [], caption })
  await select(items.length - 1)
  persist()
  return true
}

async function addFiles(list: FileList | File[]): Promise<void> {
  const files = [...list].filter((f) => f.type.startsWith('image/'))
  if (!files.length) { setMsg('Принимаются только изображения', 'warn'); return }
  let added = 0
  let refused = 0
  for (let i = 0; i < files.length; i++) {
    const url = await fileToDataUrl(files[i]!).catch(() => '')
    if (!url) { refused++; continue }
    // A refusal (the cap) applies to everything still queued behind it — count them all, or a green
    // "added 5" would quietly bury the fact that two pictures never made it in.
    if (!(await addImage(url))) { refused += files.length - i; break }
    added++
  }
  if (!added) return // addImage has already said why nothing landed
  setMsg(
    refused
      ? `Добавлено: ${added}, не поместилось: ${refused} (предел ${MAX_ATTACHMENTS})`
      : `Добавлено: ${added} · вложений всего ${items.length - 1}`,
    refused ? 'warn' : 'ok',
  )
}

// ── the strip ────────────────────────────────────────────────────────────────────────────────────────────
// Thumbnails show the BASE image plus a count of the markup on it. Baking markup into every thumbnail would
// mean re-rendering ten canvases on every stroke; the "✎ N" badge says the same thing for free and stays
// truthful after a restore, before any item has been opened.
//
// Nodes are cached per item and reused: rebuilding the strip's innerHTML on every stroke would make the
// browser re-decode up to eleven multi-megabyte data URLs each time.
const stripNodes = new Map<string, HTMLElement>()

function buildStripNode(it: Item, index: number): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'shitem'
  const pic = it.base ? `<img src="${it.base}" alt="" />` : '<span class="no">кадра нет</span>'
  const ops = index === 0
    ? ''
    : `<div class="shops">
         <button data-op="up" title="Выше">▲</button>
         <button data-op="down" title="Ниже">▼</button>
         <button class="del" data-op="del" title="Удалить">✕</button>
       </div>`
  wrap.innerHTML = `<button class="sh" data-op="sel">${pic}<span class="n"></span><span class="marks"></span><span class="cap"></span></button>${ops}`
  wrap.dataset.base = String(it.base.length)
  return wrap
}

function renderStrip(): void {
  const n = items.length - 1
  cntEl.textContent = `${n} / ${MAX_ATTACHMENTS}`
  cntEl.className = n >= MAX_ATTACHMENTS ? 'cnt full' : 'cnt'

  const live = new Set<string>()
  const frag = document.createDocumentFragment()
  items.forEach((it, i) => {
    live.add(it.id)
    let node = stripNodes.get(it.id)
    // A crop replaces the picture, so the cached <img> has to be rebuilt when the base changes.
    if (!node || node.dataset.base !== String(it.base.length) || (i === 0) !== !node.querySelector('.shops')) {
      node = buildStripNode(it, i)
      stripNodes.set(it.id, node)
    }
    const sh = node.querySelector('.sh') as HTMLElement
    sh.classList.toggle('on', i === sel)
    sh.title = i === 0 ? 'Главный кадр отчёта' : `Вложение ${i}`
    ;(node.querySelector('.n') as HTMLElement).textContent = i === 0 ? 'Главный' : String(i)
    const marks = node.querySelector('.marks') as HTMLElement
    marks.textContent = it.prims.length ? `✎ ${it.prims.length}` : ''
    marks.hidden = !it.prims.length
    const cap = node.querySelector('.cap') as HTMLElement
    cap.hidden = i === 0
    cap.textContent = it.caption.trim() || 'без подписи'
    cap.classList.toggle('empty', !it.caption.trim())
    const ups = node.querySelectorAll<HTMLButtonElement>('[data-op="up"], [data-op="down"]')
    if (ups.length === 2) {
      ups[0]!.disabled = i <= 1
      ups[1]!.disabled = i >= items.length - 1
    }
    node.dataset.i = String(i)
    frag.appendChild(node)
  })
  for (const id of [...stripNodes.keys()]) if (!live.has(id)) stripNodes.delete(id)
  strip.replaceChildren(frag)
}

strip.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-op]') as HTMLElement | null
  if (!btn) return
  const i = Number((btn.closest('.shitem') as HTMLElement | null)?.dataset.i)
  if (!Number.isFinite(i)) return
  const op = btn.dataset.op
  if (op === 'sel') { void select(i); return }
  if (op === 'up' && i > 1) { swap(i, i - 1); return }
  if (op === 'down' && i < items.length - 1) { swap(i, i + 1); return }
  if (op === 'del') void removeItem(i)
})

function swap(a: number, b: number): void {
  syncActiveItem()
  const tmp = items[a]!
  items[a] = items[b]!
  items[b] = tmp
  if (sel === a) sel = b
  else if (sel === b) sel = a
  renderStrip()
  persist()
  setMsg('Порядок вложений — это их нумерация в тикете')
}

async function removeItem(i: number): Promise<void> {
  const it = items[i]
  if (!it || i === 0) return
  const what = it.caption.trim() ? `«${it.caption.trim()}»` : `вложение ${i}`
  if (!confirm(`Удалить ${what}? Разметка на нём будет потеряна.`)) return
  syncActiveItem()
  items.splice(i, 1)
  stripNodes.delete(it.id)
  // The annotator still holds the DELETED item's picture and markup. select() starts by writing that state
  // back into whatever `sel` points at — which after the splice is a different item — so freeze the write
  // first. Without this, deleting an attachment quietly overwrote its neighbour with the deleted one's canvas.
  hydrating = true
  const next = Math.min(sel > i ? sel - 1 : sel, items.length - 1)
  await select(next)
  persist()
  setMsg('Вложение удалено')
}

// ── selection ────────────────────────────────────────────────────────────────────────────────────────────
async function select(i: number): Promise<void> {
  syncActiveItem()
  sel = Math.max(0, Math.min(items.length - 1, i))
  const it = items[sel]!
  hydrating = true
  if (it.base) {
    canvas.hidden = false
    noimg.classList.remove('on')
    try {
      await ann.setImage(it.base)
      ann.setPrims(it.prims)
    } catch {
      setMsg('Кадр не загрузился', 'err')
    }
    activeDims = `${canvas.width}x${canvas.height}`
  } else {
    canvas.hidden = true
    noimg.classList.add('on')
    activeDims = ''
  }
  hydrating = false
  lastPrimSig = activeDims + '|' + JSON.stringify(it.prims)
  capWrap.classList.toggle('on', sel > 0)
  capIn.value = it.caption
  refresh()
  renderStrip()
}

// ── annotator wiring ─────────────────────────────────────────────────────────────────────────────────────
// ImageAnnotator attaches NO listeners of its own — every pointer event below is required for anything to
// draw at all. Wired exactly as the overlay wires it, so both surfaces behave identically.
const ann = new ImageAnnotator(canvas, { onChange: () => refresh(), onTextRequest: openTextInput })

let undoBtn: HTMLButtonElement
let redoBtn: HTMLButtonElement
let clearBtn: HTMLButtonElement
let lastPrimSig = ''

function refresh(): void {
  if (!undoBtn) return // the toolbar is built below; an onChange before that has nothing to reflect
  undoBtn.disabled = !ann.canUndo()
  redoBtn.disabled = !ann.canRedo()
  clearBtn.disabled = !ann.canClear()
  document.querySelectorAll('.tb.tool').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tool === ann.tool))
  paintCursor()
  autosaveMarkup()
}

// onChange also fires for tool and colour changes, which are not work worth a storage write. Compare the
// markup itself: primitives are few and small, so stringifying them is far cheaper than the write it prevents.
function autosaveMarkup(): void {
  if (hydrating || draftDead) return
  const sig = `${canvas.width}x${canvas.height}` + '|' + JSON.stringify(ann.getPrims())
  if (sig === lastPrimSig) return
  lastPrimSig = sig
  syncActiveItem()
  renderStrip() // the "✎ N" badge on the current thumbnail
  persist()
}

function paintCursor(): void {
  const t = ann.tool
  tcur.dataset.tool = t
  if (t === 'eraser') { tcur.classList.remove('on'); return }
  tcur.innerHTML = TOOL_CURSORS[t as Exclude<Tool, 'eraser'>]
}

canvas.addEventListener('pointerenter', () => { if (ann.tool !== 'eraser') tcur.classList.add('on') })
canvas.addEventListener('pointerleave', () => { tcur.classList.remove('on'); ann.pointerUp() })
canvas.addEventListener('pointerdown', (e) => {
  // Text & eraser are single-click actions — capturing the pointer would steal focus from the text input.
  if (ann.tool !== 'text' && ann.tool !== 'eraser') canvas.setPointerCapture(e.pointerId)
  ann.pointerDown(e.clientX, e.clientY)
})
canvas.addEventListener('pointermove', (e) => {
  tcur.style.left = e.clientX + 'px'
  tcur.style.top = e.clientY + 'px'
  ann.pointerMove(e.clientX, e.clientY)
})
canvas.addEventListener('pointerup', () => ann.pointerUp())

function openTextInput(clientX: number, clientY: number): void {
  pendingText = { x: clientX, y: clientY }
  tin.style.left = Math.min(clientX, window.innerWidth - 300) + 'px'
  tin.style.top = Math.min(clientY + 10, window.innerHeight - 92) + 'px'
  tin.style.display = 'flex'
  tmark.style.left = clientX + 'px'
  tmark.style.top = clientY + 'px'
  tmark.style.display = 'block'
  tinInput.value = ''
  setTimeout(() => { tinInput.focus(); tinInput.select() }, 0)
}
function hideTextInput(): void { tin.style.display = 'none'; tmark.style.display = 'none' }
function commitTextInput(): void {
  const s = tinInput.value
  hideTextInput()
  if (pendingText && s.trim()) ann.addText(pendingText.x, pendingText.y, s)
  pendingText = null
}
tinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitTextInput() }
  else if (e.key === 'Escape') { e.preventDefault(); hideTextInput(); pendingText = null }
})
tinInput.addEventListener('blur', commitTextInput)
document.querySelectorAll('.tinsz button').forEach((el) => {
  el.addEventListener('mousedown', (e) => e.preventDefault()) // keep the text input focused when picking a size
  el.addEventListener('click', () => {
    ann.setTextSize((el as HTMLElement).dataset.tsz as Width)
    document.querySelectorAll('.tinsz button').forEach((b) => b.classList.toggle('on', b === el))
  })
})

// ── toolbar ──────────────────────────────────────────────────────────────────────────────────────────────
toolsRow.innerHTML =
  TOOL_ICONS.map(({ tool, icon }) => {
    const key = Object.entries(TOOL_CODES).find(([, v]) => v === tool)?.[0]?.replace(/^Key/, '') ?? '—'
    return `<button class="tb tool${tool === 'rect' ? ' on' : ''}" data-tool="${tool}" title="${TOOL_LABELS[tool]} · ${key}">${icon}</button>`
  }).join('') +
  '<button class="tb" data-act="undo" disabled title="Отменить · Ctrl+Z">↩</button>' +
  '<button class="tb" data-act="redo" disabled title="Повторить · Ctrl+Y">↪</button>' +
  '<button class="tb" data-act="clear" disabled title="Очистить всё · Shift+Del">🗑</button>'
undoBtn = q<HTMLButtonElement>('[data-act="undo"]')
redoBtn = q<HTMLButtonElement>('[data-act="redo"]')
clearBtn = q<HTMLButtonElement>('[data-act="clear"]')
toolsRow.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null
  if (!b) return
  if (b.dataset.tool) { ann.setTool(b.dataset.tool as Tool); return }
  if (b.dataset.act === 'undo') ann.undo()
  else if (b.dataset.act === 'redo') ann.redo()
  else if (b.dataset.act === 'clear') ann.clearAll()
})

function pickColor(c: string): void {
  ann.setColor(c)
  const i = Math.max(0, DEFAULT_COLORS.indexOf(c))
  cknob.style.left = `${((i + 0.5) / DEFAULT_COLORS.length) * 100}%`
  cknob.style.color = c
}
function pickWidth(w: Width): void {
  ann.setWidth(w)
  wknob.style.left = w === 'thin' ? '16%' : w === 'med' ? '50%' : '84%'
  wknob.style.width = w === 'thin' ? '12px' : w === 'med' ? '16px' : '22px'
  wknob.style.height = wknob.style.width
  wknob.style.marginLeft = `-${parseInt(wknob.style.width, 10) / 2}px`
  wknob.style.marginTop = `-${parseInt(wknob.style.width, 10) / 2}px`
}
// Pointer capture makes the knob follow the finger past the slider's own edges — the same reliability as a
// native <input type=range>.
function bindSlider(bar: HTMLElement, onPick: (x: number) => void): void {
  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId)
    onPick(e.clientX)
    const move = (ev: PointerEvent) => onPick(ev.clientX)
    const up = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      bar.removeEventListener('pointercancel', up)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
    bar.addEventListener('pointercancel', up)
  })
}
bindSlider(cbar, (x) => {
  const r = cbar.getBoundingClientRect()
  const t = Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)))
  pickColor(DEFAULT_COLORS[Math.min(DEFAULT_COLORS.length - 1, Math.floor(t * DEFAULT_COLORS.length))]!)
})
bindSlider(wbar, (x) => {
  const r = wbar.getBoundingClientRect()
  const t = Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)))
  pickWidth(t < 0.34 ? 'thin' : t < 0.67 ? 'med' : 'thick')
})
pickColor(DEFAULT_COLORS[0]!)
pickWidth('med')

// ── taxonomy ─────────────────────────────────────────────────────────────────────────────────────────────
typeSeg.innerHTML = TYPES.map((t) => `<button data-v="${t.value}">${t.icon} ${t.label}</button>`).join('')
sevSeg.innerHTML = SEVERITIES.map((s) => `<button data-v="${s}">${s}</button>`).join('')
function syncTypeSev(): void {
  typeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === type))
  sevSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === severity))
  const t = TYPES.find((x) => x.value === type)!
  titleEl.textContent = `${t.icon} ${t.label} — редактор`
}
typeSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.dataset.v as ReportType | undefined
  if (!v) return
  type = v
  syncTypeSev()
  persist()
})
sevSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.dataset.v as Severity | undefined
  if (!v) return
  severity = v
  syncTypeSev()
  persist()
})
psel.addEventListener('change', () => {
  projectId = psel.value || null
  if (projectId) void setConfig({ lastProjectId: projectId }) // remembered for the next report
  persist()
})

note.addEventListener('input', () => persist({}, false)) // typing is the one change frequent enough to debounce
capIn.addEventListener('input', () => {
  const it = items[sel]
  if (!it || sel === 0) return
  it.caption = capIn.value
  persist({}, false)
})
// Repainting the strip on every keystroke would re-decode the thumbnails; the caption lands there on blur.
capIn.addEventListener('change', () => renderStrip())
capIn.addEventListener('blur', () => renderStrip())

// ── talking to the target tab (through the background) ───────────────────────────────────────────────────
async function ask<T>(msg: Record<string, unknown>): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T
  } catch {
    return null
  }
}

// A fresh frame of the tab the capture started from. captureVisibleTab can only photograph the tab that is
// actually visible, so a tab hidden behind another one is reported honestly instead of silently handing back
// a picture of something else.
async function shootTarget(): Promise<string> {
  if (targetTabId == null) {
    setMsg('Не знаю, какую вкладку снимать — откройте редактор с нужной страницы', 'err')
    return ''
  }
  const res = await ask<{ ok?: boolean; shot?: string; error?: string }>({ type: 'TH_SHOT', tabId: targetTabId })
  if (!res?.ok || !res.shot) {
    setMsg('Кадр не снят: ' + (res?.error || 'вкладка недоступна') + '. Сделайте её активной и попробуйте снова.', 'err')
    return ''
  }
  return res.shot
}

async function refreshContext(): Promise<void> {
  if (targetTabId == null) return
  const res = await ask<{ ok?: boolean; bundle?: ReproBundle | null }>({ type: 'TH_CTX', tabId: targetTabId })
  if (res?.ok && res.bundle) {
    context = res.bundle
    renderCtxHint()
    persist()
  }
}

function renderCtxHint(): void {
  if (!context) { ctxHint.innerHTML = ''; return }
  const bits: string[] = []
  const errs = (context.console ?? []).filter((c) => c.level === 'error').length
  if (context.actions?.length) bits.push(`<b>${context.actions.length}</b> steps`)
  if (context.console?.length) bits.push(`<b>${context.console.length}</b> console`)
  if (context.network?.length) bits.push(`<b>${context.network.length}</b> net`)
  if (errs) bits.push(`<b>${errs}</b> err`)
  ctxHint.innerHTML = bits.length ? '📋 ' + bits.join(' · ') : ''
}

q<HTMLElement>('[data-add="file"]').addEventListener('click', () => fileIn.click())
fileIn.addEventListener('change', () => {
  if (fileIn.files?.length) void addFiles(fileIn.files)
  fileIn.value = '' // so picking the same file twice in a row still fires change
})
q<HTMLElement>('[data-add="shot"]').addEventListener('click', () => {
  void (async () => {
    setMsg('Снимаю кадр вкладки…')
    const shot = await shootTarget()
    if (!shot) return
    if (await addImage(shot)) setMsg('Кадр вкладки добавлен ✓', 'ok')
    void refreshContext()
  })()
})

// ── video: records the TARGET TAB, never this window ─────────────────────────────────────────────────────
let recording = false
let recTimer: ReturnType<typeof setInterval> | null = null

function renderVideo(): void {
  vdropBtn.hidden = !video || recording
  if (recording) return
  recBtn.textContent = '⏺ Записать репро'
  recBtn.classList.remove('on')
  if (!video) {
    vidSt.className = 'vidst'
    vidSt.textContent = 'записи нет — покажите баг в действии'
    recSt.textContent = ''
    return
  }
  vidSt.className = 'vidst ok'
  vidSt.textContent = `🎬 ${fmtT(video.seconds)} · ${(video.bytes / 1e6).toFixed(1)} МБ${video.capped ? ' (обрезано на лимите)' : ''}`
  recSt.className = 'recst ok'
  recSt.textContent = `🎬 видео ${fmtT(video.seconds)}`
}

recBtn.addEventListener('click', () => { void (recording ? stopRec() : startRec()) })
vdropBtn.addEventListener('click', () => {
  if (!video || !confirm('Убрать видео из тикета?')) return
  video = null
  renderVideo()
  persist()
  setMsg('Видео убрано')
})

async function startRec(): Promise<void> {
  if (recording) return
  if (targetTabId == null) { setMsg('Нет вкладки для записи — откройте редактор с нужной страницы', 'err'); return }
  const cfg = await getConfig()
  const res = await ask<{ ok?: boolean; error?: string }>({
    type: 'TH_VIDEO_START',
    tabId: targetTabId, // this window has no content script, so the background cannot infer the tab from sender
    maxSeconds: REC_MAX_SECONDS,
    collectorUrl: cfg.collectorUrl,
  })
  if (!res?.ok) {
    setMsg('Не удалось начать запись: ' + (res?.error || 'нет доступа к вкладке'), 'err')
    return
  }
  recording = true
  const t0 = Date.now()
  recBtn.textContent = '⏹ Стоп'
  recBtn.classList.add('on')
  vdropBtn.hidden = true
  vidSt.className = 'vidst live'
  setMsg('Идёт запись вкладки — воспроизведите баг там, потом вернитесь и нажмите «Стоп»')
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000)
    vidSt.textContent = `🔴 запись ${fmtT(s)} — переключитесь на вкладку`
    recSt.className = 'recst warn'
    recSt.textContent = `🔴 ${fmtT(s)}`
  }, 250)
}

async function stopRec(): Promise<void> {
  if (!recording) return
  recording = false
  if (recTimer) { clearInterval(recTimer); recTimer = null }
  setMsg('Останавливаю запись…')
  const res = await ask<{
    ok?: boolean; url?: string; seconds?: number; bytes?: number; capped?: boolean
    frames?: { at: number; dataUrl: string }[]; error?: string
  }>({ type: 'TH_VIDEO_STOP' })
  if (!res?.ok || !res.url) {
    renderVideo()
    setMsg('Запись не получилась: ' + (res?.error || 'пустой файл'), 'err')
    return
  }
  video = {
    url: res.url,
    seconds: Number(res.seconds || 0),
    bytes: Number(res.bytes || 0),
    capped: !!res.capped,
    frames: Array.isArray(res.frames) ? res.frames : [],
  }
  renderVideo()
  persist() // the most expensive artefact in the report — saved before anything else can go wrong
  const capped = video.capped ? ' — обрезано на лимите 38 МБ' : ''
  setMsg(`Видео записано: ${fmtT(video.seconds)} · ${(video.bytes / 1e6).toFixed(1)} МБ ✓${capped}`, video.capped ? 'warn' : 'ok')
  void refreshContext()
  // The closing frame of a repro is usually the evidence itself. It becomes a NEW attachment rather than
  // replacing the main screenshot, which may already carry the tester's markup.
  const shot = await shootTarget().catch(() => '')
  if (shot) void addImage(shot, 'Итог записи')
}

// ── clipboard, drag & drop ───────────────────────────────────────────────────────────────────────────────
// The owner asked for the paste path explicitly: a screenshot taken with any other tool goes into the ticket
// with one keystroke.
window.addEventListener('paste', (e: ClipboardEvent) => {
  const cbItems = e.clipboardData?.items
  if (!cbItems) return
  const files: File[] = []
  for (let i = 0; i < cbItems.length; i++) {
    const it = cbItems[i]!
    if (it.kind !== 'file' || !it.type.startsWith('image/')) continue
    const f = it.getAsFile()
    if (f) files.push(f)
  }
  if (!files.length) return // a plain text paste must keep working in the note and caption fields
  e.preventDefault()
  void addFiles(files)
})

let dragDepth = 0
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropEl.classList.add('on') })
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.classList.remove('on') })
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  dropEl.classList.remove('on')
  const f = e.dataTransfer?.files
  if (f?.length) void addFiles(f)
})

// ── keyboard ─────────────────────────────────────────────────────────────────────────────────────────────
// Esc deliberately does NOT close this window: closing is the OS window control, and losing a long report to a
// stray Esc is the exact failure this window exists to remove.
document.addEventListener('keydown', (e) => {
  const ae = document.activeElement as HTMLElement | null
  const typing = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')
  const mod = e.ctrlKey || e.metaKey
  const code = e.code

  if (mod && (code === 'Enter' || code === 'NumpadEnter')) { e.preventDefault(); sendBtn.click(); return }
  if (mod && code === 'KeyZ') { if (typing) return; e.preventDefault(); if (e.shiftKey) ann.redo(); else ann.undo(); return }
  if (mod && code === 'KeyY') { if (typing) return; e.preventDefault(); ann.redo(); return }
  if (mod) return // Ctrl+V and every other browser combo belongs to the browser

  if (typing) return
  if (e.shiftKey && (code === 'Delete' || code === 'Backspace')) { e.preventDefault(); ann.clearAll(); return }
  const tool = TOOL_CODES[code]
  if (tool) { e.preventDefault(); ann.setTool(tool); return }
  const w = WIDTH_CODES[code]
  if (w) { e.preventDefault(); pickWidth(w); return }
  if (code === 'KeyF') {
    e.preventDefault()
    const cur = DEFAULT_COLORS.indexOf(ann.color)
    pickColor(DEFAULT_COLORS[(cur + (e.shiftKey ? -1 : 1) + DEFAULT_COLORS.length) % DEFAULT_COLORS.length]!)
  }
})

// The debounce is a race against the window going away; flush what is buffered while there still is a window.
window.addEventListener('pagehide', () => { if (!draftDead) { persist(); void flushDrafts() } })

// ── sending ──────────────────────────────────────────────────────────────────────────────────────────────
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/jpeg'
  const bin = atob(b64 ?? '')
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return new Blob([buf], { type: mime })
}

// Upload the bytes and keep only the URL: ten inline images would make the ingest body tens of megabytes.
// Returns null on any failure so the caller can fall back to inlining rather than dropping the picture.
async function uploadImage(collectorUrl: string, dataUrl: string): Promise<string | null> {
  try {
    const blob = dataUrlToBlob(dataUrl)
    if (blob.size > UPLOAD_MAX_BYTES) return null
    const res = await fetch(collectorUrl.replace(/\/+$/, '') + '/api/upload/image', {
      method: 'POST',
      headers: { 'content-type': blob.type },
      body: blob,
    })
    const j = (await res.json().catch(() => null)) as { ok?: boolean; url?: string } | null
    return res.ok && j?.ok && j.url ? j.url : null
  } catch {
    return null
  }
}

// Bake one item's markup into its picture by loading it into the annotator — the same renderer the tester drew
// with, so what ships is exactly what they saw. Nothing here re-implements drawing.
async function flatten(i: number): Promise<string> {
  await select(i)
  return items[i]!.base ? ann.toDataURL(EXPORT_QUALITY) : ''
}

sendBtn.addEventListener('click', () => { void send() })

async function send(): Promise<void> {
  if (sending) return
  sending = true
  sendBtn.disabled = true
  syncActiveItem()
  const cfg = await getConfig()
  const back = sel
  setMsg('Готовлю кадры…')

  const screenshot = await flatten(0)
  const attachments: ({ url: string; caption: string } | { image: string; caption: string })[] = []
  let inlined = 0
  for (let i = 1; i < items.length; i++) {
    setMsg(`Готовлю вложение ${i} из ${items.length - 1}…`)
    const flat = await flatten(i)
    if (!flat) continue
    const caption = items[i]!.caption.trim()
    const url = await uploadImage(cfg.collectorUrl, flat)
    if (url) attachments.push({ url, caption })
    else { attachments.push({ image: flat, caption }); inlined++ }
  }
  await select(back)

  // The report describes the PAGE, not this window. Sending the editor's own viewport would point the reader
  // at a size the site was never rendered at, so the target tab's own numbers win whenever we have them.
  const env = context?.env
  const [envW, envH] = (env?.viewport ?? '').split('x').map(Number)
  const payload = buildReport({
    ingestKey: cfg.ingestKey,
    note: note.value,
    type,
    severity,
    screenshot: screenshot || undefined,
    pageUrl: pageUrl || location.href,
    innerWidth: envW > 0 ? envW : window.innerWidth,
    innerHeight: envH > 0 ? envH : window.innerHeight,
    userAgent: env?.userAgent || navigator.userAgent,
    // Keep the bundle the target tab gave us, and say where the report was composed: a ticket with no action
    // trail must explain WHY it has none instead of looking like a server-side loss.
    context: context
      ? ({
          ...context,
          diag: { source: 'editor-window', attachments: attachments.length, extVersion: chrome.runtime.getManifest?.().version ?? '?' },
        } as ReproBundle)
      : null,
    projectId,
  })
  if (!payload.note && !payload.screenshot && !attachments.length) {
    setMsg('Пусто: напишите заметку или добавьте кадр', 'err')
    sending = false
    sendBtn.disabled = false
    return
  }

  setMsg('Отправляю…')
  const res = await ask<{ ok?: boolean; id?: string; attachments?: number; error?: string }>({
    type: 'TH_SEND',
    collectorUrl: cfg.collectorUrl,
    payload: {
      ...payload,
      attachments,
      videoUrl: video?.url,
      videoSeconds: video ? Math.round(video.seconds) : undefined,
      // An agent cannot watch a webm, so the sampled stills are what it actually looks at.
      videoFrames: video?.frames?.length ? video.frames : undefined,
    },
  })

  if (!res?.ok) {
    // Nothing is thrown away on a failure: the draft is intact and the window stays open with the reason.
    setMsg('Не отправилось: ' + (res?.error || 'сервер не ответил') + '. Черновик цел — попробуйте ещё раз.', 'err')
    sending = false
    sendBtn.disabled = false
    return
  }

  // The server has it: this is the one and only moment the draft may be thrown away automatically.
  draftDead = true
  await clearDraft(origin).catch(() => {})
  await chrome.storage.local.remove(SEED_KEY).catch(() => {})

  const stored = typeof res.attachments === 'number' ? res.attachments : attachments.length
  const link = res.id ? ` <a href="${esc(cfg.collectorUrl.replace(/\/+$/, ''))}/r/${esc(res.id)}" target="_blank">открыть тикет</a>` : ''
  if (stored < attachments.length) {
    // The ticket exists, so the draft is gone — but the tester must not discover on the dashboard that
    // pictures went missing. The window stays open until they have read this.
    setMsgHtml(`⚠ Тикет создан, но сервер принял ${stored} ${plural(stored, 'вложение', 'вложения', 'вложений')} из ${attachments.length}.${link}`, 'err')
    sendBtn.textContent = '✕ Закрыть окно'
    sendBtn.disabled = false
    sendBtn.onclick = () => closeWindow() // `sending` stays true, so the send listener above is now a no-op
    return
  }
  const inlineNote = inlined ? ` (${inlined} — файлом в теле, загрузка не прошла)` : ''
  setMsgHtml(`Отправлено ✓ вложений: ${stored}${inlineNote}.${link}`, 'ok')
  setTimeout(() => closeWindow(), 900)
}

function closeWindow(): void {
  void chrome.runtime.sendMessage({ type: 'TH_EDITOR_CLOSE' }).catch(() => {})
  window.close()
}

discardBtn.addEventListener('click', () => {
  syncActiveItem()
  const n = items.length - 1
  const what = [
    note.value.trim() ? 'заметка' : '',
    items[0]!.prims.length ? 'разметка' : '',
    n ? `${n} ${plural(n, 'вложение', 'вложения', 'вложений')}` : '',
    video ? 'видео' : '',
  ].filter(Boolean).join(', ')
  if (what && !confirm(`Удалить черновик? Будет потеряно: ${what}.\n\nЧтобы просто отложить — закройте окно, черновик сохранится.`)) return
  draftDead = true
  void clearDraft(origin).finally(() => closeWindow())
})

// ── boot ─────────────────────────────────────────────────────────────────────────────────────────────────
async function readSeed(): Promise<Seed | null> {
  const got = await chrome.storage.local.get(SEED_KEY).catch(() => ({}) as Record<string, unknown>)
  const seed = got[SEED_KEY] as Seed | undefined
  if (!seed) return null
  await chrome.storage.local.remove(SEED_KEY).catch(() => {})
  return seed
}

async function loadProjects(): Promise<void> {
  const cfg = await getConfig()
  const res = await ask<{ ok?: boolean; projects?: { id: string; name: string }[]; defaultId?: string }>({
    type: 'TH_PROJECTS',
    collectorUrl: cfg.collectorUrl,
    ingestKey: cfg.ingestKey,
  })
  if (!res?.ok || !res.projects?.length) return
  // Preference order: the draft's own choice → the project used last → the ingest key's own → the first.
  const fromDraft = projectId && res.projects.some((p) => p.id === projectId) ? projectId : ''
  const remembered = res.projects.some((p) => p.id === cfg.lastProjectId) ? cfg.lastProjectId : ''
  projectId = fromDraft || remembered || res.defaultId || res.projects[0]!.id
  psel.innerHTML = res.projects.map((p) => `<option value="${esc(p.id)}"${p.id === projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
}

function showRestored(d: Draft): void {
  const bits: string[] = []
  if (d.prims.length) bits.push(`<b>${d.prims.length}</b> ${plural(d.prims.length, 'пометка', 'пометки', 'пометок')}`)
  if (d.attachments?.length) bits.push(`<b>${d.attachments.length}</b> ${plural(d.attachments.length, 'вложение', 'вложения', 'вложений')}`)
  if (d.note.trim()) bits.push('заметка')
  if (d.video) bits.push(`видео ${fmtT(d.video.seconds)}`)
  if (!bits.length) return
  restT.innerHTML = `↩ Черновик восстановлен — ${bits.join(', ')}`
  restBar.classList.add('on')
}

// A fresh frame arriving while the window is already open (the tester pressed the shortcut again) becomes an
// attachment: that is exactly the "one bug, several screens" flow this window exists for.
async function consumeSeed(seed: Seed | null): Promise<void> {
  if (!seed) return
  if (seed.origin && origin && seed.origin !== origin) {
    setMsg(`Окно занято черновиком ${origin} — кадр с ${seed.origin} не добавлен. Отправьте или отложите текущий тикет.`, 'warn')
    return
  }
  if (seed.tabId != null) targetTabId = seed.tabId
  if (seed.pageUrl) { pageUrl = seed.pageUrl; targetEl.textContent = pageUrl }
  if (!seed.shot) return
  if (await addImage(seed.shot)) {
    setMsg(items.length > 1 ? `Свежий кадр добавлен как вложение ${items.length - 1}` : 'Свежий кадр загружен ✓', 'ok')
  }
}

async function boot(): Promise<void> {
  targetEl.textContent = pageUrl
  syncTypeSev()
  renderVideo()

  if (!origin) {
    hydrating = false
    renderStrip()
    setMsg('Редактор открыт без страницы-цели. Нажмите Ctrl+Shift+U на нужной вкладке.', 'err')
    return
  }

  const seed = await readSeed()
  const draft = await loadDraft(origin).catch(() => null)
  const restored = hasContent(draft) ? draft : null

  if (draft) {
    note.value = draft.note
    type = draft.type
    severity = draft.severity
    projectId = draft.projectId
    video = draft.video
    context = (draft.context as ReproBundle | null) ?? null
    if (draft.pageUrl && !pageUrl) pageUrl = draft.pageUrl
    items[0] = { id: 'main', base: draft.shot?.dataUrl ?? '', prims: (draft.prims as Prim[]) ?? [], caption: '' }
    for (const a of draft.attachments ?? []) {
      items.push({ id: a.id || uid(), base: a.base, prims: (a.prims as Prim[]) ?? [], caption: a.caption ?? '' })
    }
  }

  // A brand-new capture: the frame the shortcut took IS the report's screenshot. A previous capture that was
  // never written on is not work — a fresh frame replaces it instead of piling up behind it.
  const seedIsMain = !!seed?.shot && (!items[0]!.base || !restored)
  if (seedIsMain) {
    items[0]!.base = await normalizeImage(seed!.shot).catch(() => seed!.shot)
    if (seed!.tabId != null) targetTabId = seed!.tabId
    if (seed!.pageUrl) pageUrl = seed!.pageUrl
  }

  targetEl.textContent = pageUrl
  syncTypeSev()
  renderVideo()
  renderCtxHint()
  await select(0)
  hydrating = false
  markBooted() // items[0] is settled; images may now be added — including by the seed handling just below

  if (restored) showRestored(restored)
  // The seed arrived on top of existing work: it joins as an attachment instead of replacing anything.
  if (seed && !seedIsMain) await consumeSeed(seed)
  else if (!restored) persist() // a capture is worth keeping from its first second, not from the first edit

  void loadProjects()
  if (!context) void refreshContext()
  note.focus()
}

// The background wakes an already-open window when the shortcut is pressed again.
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type !== 'TH_ED_SEED') return undefined
  void (async () => { await consumeSeed(await readSeed()) })()
  return undefined // nothing here answers asynchronously; never hold open a channel we cannot close
})

// The gate is released whatever happens: a boot that failed must not leave paste and drop hanging forever.
void boot()
  .catch((e: unknown) => setMsg('Черновик не открылся: ' + String(e), 'err'))
  .finally(() => markBooted())
