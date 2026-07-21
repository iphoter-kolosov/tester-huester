// Framework-agnostic image annotator: draw, arrow, rect, text, eraser, crop (with undo), export. Ported from
// the eRENTAL 🐞 widget's canvas logic and made dependency-free so any client — a browser extension, a React
// app, anything — can drive it. It owns one visible <canvas>; everything else is plain state.
//
// The drawing model is a discriminated union of primitives (freehand / arrow / rect / text). Each primitive
// carries its own color + stroke width so undo/redo/erase can act on the whole mixed stack uniformly.

export type Point = { x: number; y: number }

// Stroke weight as a preset (kept symbolic so the pixel width can scale with canvas size at render time).
export type Width = 'thin' | 'med' | 'thick'

export type Freehand = { kind: 'freehand'; color: string; width: Width; pts: Point[] }
export type Arrow = { kind: 'arrow'; color: string; width: Width; a: Point; b: Point }
export type RectPrim = { kind: 'rect'; color: string; width: Width; a: Point; b: Point }
export type TextPrim = { kind: 'text'; color: string; p: Point; str: string; size: number }
export type Prim = Freehand | Arrow | RectPrim | TextPrim

// Back-compat alias: the old model was a single freehand stroke. Old imports keep working.
export type Stroke = Freehand

export type Tool = 'draw' | 'arrow' | 'rect' | 'text' | 'eraser' | 'crop'

// Undo/redo works over a command log so erasing (which removes a primitive from the middle of the stack) is
// reversible in the same stack as adding.
type Cmd = { op: 'add'; prim: Prim } | { op: 'erase'; prim: Prim; index: number } | { op: 'crop'; pre: Snapshot; post: Snapshot }

type Drawable = CanvasImageSource & { width: number; height: number }
type Snapshot = { img: Drawable | null; prims: Prim[]; w: number; h: number }

export const DEFAULT_COLORS = ['#ff3b30', '#ffcc00', '#0a84ff', '#0c1526']
export const DEFAULT_WIDTH: Width = 'med'
// Multipliers applied to a canvas-scaled base width, so lines stay proportional on tiny and huge screenshots.
const WIDTH_MUL: Record<Width, number> = { thin: 0.6, med: 1, thick: 1.7 }
const MAXPX = 4_000_000 // clamp huge photos so annotation stays crisp and exports stay small

export type AnnotatorOptions = {
  color?: string
  width?: Width
  onChange?: () => void
  // Fired when the text tool is used: the host shows its own input, then calls addText() with the string.
  onTextRequest?: (clientX: number, clientY: number) => void
  // Injectable so this is unit-testable off-DOM; defaults to real offscreen canvases in the browser.
  createCanvas?: () => HTMLCanvasElement
}

function deepPrim(p: Prim): Prim {
  switch (p.kind) {
    case 'freehand': return { ...p, pts: p.pts.map((q) => ({ ...q })) }
    case 'arrow': return { ...p, a: { ...p.a }, b: { ...p.b } }
    case 'rect': return { ...p, a: { ...p.a }, b: { ...p.b } }
    case 'text': return { ...p, p: { ...p.p } }
  }
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export class ImageAnnotator {
  color: string
  width: Width
  textSize: Width = 'med'
  tool: Tool = 'draw'

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private createCanvas: () => HTMLCanvasElement
  private onChange: () => void
  private onTextRequest?: (clientX: number, clientY: number) => void

  private img: Drawable | null = null
  private prims: Prim[] = []
  private undoStack: Cmd[] = []
  private redoStack: Cmd[] = []
  private cropRect: { x0: number; y0: number; x1: number; y1: number } | null = null
  private drawing = false
  private current: Prim | null = null // in-progress primitive, committed on pointerUp

  constructor(canvas: HTMLCanvasElement, opts: AnnotatorOptions = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.color = opts.color ?? DEFAULT_COLORS[0]!
    this.width = opts.width ?? DEFAULT_WIDTH
    this.onChange = opts.onChange ?? (() => {})
    this.onTextRequest = opts.onTextRequest
    this.createCanvas = opts.createCanvas ?? (() => document.createElement('canvas'))
  }

  // Browser entry: decode a data URL, then apply it. (Tests call applyImage directly with a stub.)
  setImage(dataUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => { this.applyImage(im, im.naturalWidth, im.naturalHeight); resolve() }
      im.onerror = () => reject(new Error('image decode failed'))
      im.src = dataUrl
    })
  }

  applyImage(src: Drawable, naturalW: number, naturalH: number): void {
    const scale = Math.min(1, Math.sqrt(MAXPX / Math.max(1, naturalW * naturalH)))
    this.canvas.width = Math.max(1, Math.round(naturalW * scale))
    this.canvas.height = Math.max(1, Math.round(naturalH * scale))
    this.img = src
    this.prims = []
    this.undoStack = []
    this.redoStack = []
    this.cropRect = null
    this.current = null
    this.tool = 'draw'
    this.redraw()
    this.onChange()
  }

  setColor(c: string): void { this.color = c; this.onChange() }
  setWidth(w: Width): void { this.width = w; this.onChange() }
  setTextSize(w: Width): void { this.textSize = w; this.onChange() }
  setTool(t: Tool): void { this.tool = t; this.redraw(); this.onChange() }

  pointerDown(clientX: number, clientY: number): void {
    const p = this.toCanvasCoords(clientX, clientY)
    if (this.tool === 'crop') { this.drawing = true; this.cropRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; this.redraw(); return }
    if (this.tool === 'text') { this.onTextRequest?.(clientX, clientY); return }
    if (this.tool === 'eraser') { this.eraseAt(p); return }
    this.drawing = true
    if (this.tool === 'arrow') this.current = { kind: 'arrow', color: this.color, width: this.width, a: p, b: { ...p } }
    else if (this.tool === 'rect') this.current = { kind: 'rect', color: this.color, width: this.width, a: p, b: { ...p } }
    else this.current = { kind: 'freehand', color: this.color, width: this.width, pts: [p] }
    this.redraw()
  }

  pointerMove(clientX: number, clientY: number): void {
    if (!this.drawing) return
    const p = this.toCanvasCoords(clientX, clientY)
    if (this.tool === 'crop') { if (this.cropRect) { this.cropRect.x1 = p.x; this.cropRect.y1 = p.y; this.redraw() } return }
    const cur = this.current
    if (!cur) return
    if (cur.kind === 'freehand') cur.pts.push(p)
    else if (cur.kind === 'arrow' || cur.kind === 'rect') cur.b = p
    this.redraw()
  }

  pointerUp(): void {
    if (!this.drawing) return
    this.drawing = false
    if (this.tool === 'crop') { this.finishCrop(); return }
    const cur = this.current
    this.current = null
    if (cur && this.isMeaningful(cur)) { this.commit({ op: 'add', prim: cur }) } else { this.redraw() }
  }

  // Text is added out-of-band: the host collects the string via its own input, then calls this.
  addText(clientX: number, clientY: number, str: string, size?: number): void {
    const s = str.trim()
    if (!s) return
    const p = this.toCanvasCoords(clientX, clientY)
    const sz = size ?? this.defaultTextSize()
    this.commit({ op: 'add', prim: { kind: 'text', color: this.color, p, str: s, size: sz } })
  }

  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }
  canClear(): boolean { return this.prims.length > 0 }

  // One unified timeline: adds, erases AND crops all undo/redo through the same stack, so a single Undo (or
  // Ctrl+Z) reverses whatever happened last — including a crop.
  undo(): void {
    const cmd = this.undoStack.pop()
    if (!cmd) return
    if (cmd.op === 'add') { const i = this.prims.lastIndexOf(cmd.prim); if (i >= 0) this.prims.splice(i, 1) }
    else if (cmd.op === 'erase') { this.prims.splice(Math.min(cmd.index, this.prims.length), 0, cmd.prim) }
    else { this.restoreSnapshot(cmd.pre) }
    this.redoStack.push(cmd)
    this.redraw(); this.onChange()
  }

  redo(): void {
    const cmd = this.redoStack.pop()
    if (!cmd) return
    if (cmd.op === 'add') { this.prims.push(cmd.prim) }
    else if (cmd.op === 'erase') { const i = this.prims.lastIndexOf(cmd.prim); if (i >= 0) this.prims.splice(i, 1) }
    else { this.restoreSnapshot(cmd.post) }
    this.undoStack.push(cmd)
    this.redraw(); this.onChange()
  }

  // Restore a whole frame (image + primitives + size) — used to reverse/replay a crop within the unified stack.
  private restoreSnapshot(snap: Snapshot): void {
    this.img = snap.img
    this.prims = snap.prims.map(deepPrim)
    this.current = null
    this.canvas.width = snap.w
    this.canvas.height = snap.h
  }

  clearAll(): void {
    if (!this.prims.length) return
    this.prims = []
    this.undoStack = []
    this.redoStack = []
    this.redraw(); this.onChange()
  }
  // Back-compat alias.
  clearDraw(): void { this.clearAll() }

  // Default JPEG (small, good for photo screenshots); pass 'image/png' for crisp lines / dark palettes.
  toDataURL(quality = 0.85, type: 'image/jpeg' | 'image/png' = 'image/jpeg'): string {
    this.redraw()
    return type === 'image/png' ? this.canvas.toDataURL('image/png') : this.canvas.toDataURL('image/jpeg', quality)
  }
  toPNG(): string { return this.toDataURL(1, 'image/png') }

  private commit(cmd: Cmd): void {
    if (cmd.op === 'add') this.prims.push(cmd.prim)
    this.undoStack.push(cmd)
    this.redoStack = []
    this.redraw(); this.onChange()
  }

  private eraseAt(p: Point): void {
    const tol = Math.max(12, this.pxWidth('thick') * 1.5)
    let bestI = -1, bestD = Infinity
    for (let i = 0; i < this.prims.length; i++) {
      const d = this.distToPrim(p, this.prims[i]!)
      if (d < bestD) { bestD = d; bestI = i }
    }
    if (bestI < 0 || bestD > tol) return
    const prim = this.prims[bestI]!
    this.prims.splice(bestI, 1)
    this.undoStack.push({ op: 'erase', prim, index: bestI })
    this.redoStack = []
    this.redraw(); this.onChange()
  }

  private distToPrim(p: Point, prim: Prim): number {
    switch (prim.kind) {
      case 'arrow': return distToSeg(p, prim.a, prim.b)
      case 'freehand': {
        const pts = prim.pts
        if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y)
        let min = Infinity
        for (let i = 1; i < pts.length; i++) min = Math.min(min, distToSeg(p, pts[i - 1]!, pts[i]!))
        return min
      }
      case 'rect': {
        const x0 = Math.min(prim.a.x, prim.b.x), y0 = Math.min(prim.a.y, prim.b.y)
        const x1 = Math.max(prim.a.x, prim.b.x), y1 = Math.max(prim.a.y, prim.b.y)
        const tl = { x: x0, y: y0 }, tr = { x: x1, y: y0 }, br = { x: x1, y: y1 }, bl = { x: x0, y: y1 }
        return Math.min(distToSeg(p, tl, tr), distToSeg(p, tr, br), distToSeg(p, br, bl), distToSeg(p, bl, tl))
      }
      case 'text': {
        const w = Math.max(prim.size, prim.str.length * prim.size * 0.55), h = prim.size * 1.2
        const dx = Math.max(prim.p.x - p.x, 0, p.x - (prim.p.x + w))
        const dy = Math.max(prim.p.y - p.y, 0, p.y - (prim.p.y + h))
        return Math.hypot(dx, dy)
      }
    }
  }

  private isMeaningful(prim: Prim): boolean {
    if (prim.kind === 'freehand') return prim.pts.length > 1
    if (prim.kind === 'arrow' || prim.kind === 'rect') return Math.hypot(prim.b.x - prim.a.x, prim.b.y - prim.a.y) >= 5
    return true
  }

  private toCanvasCoords(clientX: number, clientY: number): Point {
    const r = this.canvas.getBoundingClientRect()
    return {
      x: (clientX - r.left) * (this.canvas.width / (r.width || 1)),
      y: (clientY - r.top) * (this.canvas.height / (r.height || 1)),
    }
  }

  private pxWidth(w: Width): number {
    const base = Math.max(2.5, this.canvas.width / 320)
    return base * WIDTH_MUL[w]
  }
  private defaultTextSize(): number {
    const base = Math.max(14, Math.round(this.canvas.width / 34))
    return Math.round(base * ({ thin: 0.8, med: 1.2, thick: 1.9 } as Record<Width, number>)[this.textSize])
  }

  private drawPrim(ctx: CanvasRenderingContext2D, prim: Prim): void {
    switch (prim.kind) {
      case 'freehand': {
        ctx.strokeStyle = prim.color; ctx.lineWidth = this.pxWidth(prim.width)
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.beginPath()
        prim.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
        ctx.stroke()
        break
      }
      case 'arrow': {
        const lw = this.pxWidth(prim.width)
        ctx.strokeStyle = prim.color; ctx.fillStyle = prim.color; ctx.lineWidth = lw
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.beginPath(); ctx.moveTo(prim.a.x, prim.a.y); ctx.lineTo(prim.b.x, prim.b.y); ctx.stroke()
        const ang = Math.atan2(prim.b.y - prim.a.y, prim.b.x - prim.a.x)
        const head = Math.max(10, lw * 3.2), spread = Math.PI / 7
        ctx.beginPath()
        ctx.moveTo(prim.b.x, prim.b.y)
        ctx.lineTo(prim.b.x - head * Math.cos(ang - spread), prim.b.y - head * Math.sin(ang - spread))
        ctx.lineTo(prim.b.x - head * Math.cos(ang + spread), prim.b.y - head * Math.sin(ang + spread))
        ctx.closePath(); ctx.fill()
        break
      }
      case 'rect': {
        const x = Math.min(prim.a.x, prim.b.x), y = Math.min(prim.a.y, prim.b.y)
        const w = Math.abs(prim.b.x - prim.a.x), h = Math.abs(prim.b.y - prim.a.y)
        ctx.strokeStyle = prim.color; ctx.lineWidth = this.pxWidth(prim.width); ctx.lineJoin = 'miter'
        ctx.strokeRect(x, y, w, h)
        break
      }
      case 'text': {
        ctx.fillStyle = prim.color
        ctx.textBaseline = 'top'
        ctx.font = `700 ${prim.size}px system-ui, sans-serif`
        // A subtle dark halo keeps text readable over both light and dark regions.
        ctx.save()
        ctx.lineJoin = 'round'
        ctx.lineWidth = Math.max(2, prim.size / 6)
        ctx.strokeStyle = 'rgba(3,7,18,.75)'
        ctx.strokeText(prim.str, prim.p.x, prim.p.y)
        ctx.restore()
        ctx.fillText(prim.str, prim.p.x, prim.p.y)
        break
      }
    }
  }

  private redraw(): void {
    const c = this.canvas, ctx = this.ctx
    ctx.clearRect(0, 0, c.width, c.height)
    if (this.img) ctx.drawImage(this.img, 0, 0, c.width, c.height)
    for (const prim of this.prims) this.drawPrim(ctx, prim)
    if (this.current) this.drawPrim(ctx, this.current)
    const rc = this.cropRect
    if (this.tool === 'crop' && rc) {
      const x = Math.min(rc.x0, rc.x1), y = Math.min(rc.y0, rc.y1), w = Math.abs(rc.x1 - rc.x0), h = Math.abs(rc.y1 - rc.y0)
      ctx.save()
      ctx.fillStyle = 'rgba(3,7,18,.5)'
      ctx.fillRect(0, 0, c.width, y); ctx.fillRect(0, y + h, c.width, c.height - (y + h))
      ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, c.width - (x + w), h)
      ctx.strokeStyle = '#0a84ff'; ctx.setLineDash([7, 5]); ctx.lineWidth = Math.max(1.5, c.width / 380)
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }
  }

  private finishCrop(): void {
    const c = this.canvas, rc = this.cropRect
    this.cropRect = null
    if (!rc) { this.redraw(); return }
    const x = Math.min(rc.x0, rc.x1), y = Math.min(rc.y0, rc.y1), w = Math.abs(rc.x1 - rc.x0), h = Math.abs(rc.y1 - rc.y0)
    if (w < 12 || h < 12) { this.redraw(); return }

    // Bake image + primitives onto a scratch canvas, lift the region into a new image (no dataURL round-trip).
    const src = this.createCanvas()
    src.width = c.width; src.height = c.height
    const sctx = src.getContext('2d')!
    if (this.img) sctx.drawImage(this.img, 0, 0, c.width, c.height)
    for (const prim of this.prims) this.drawPrim(sctx, prim)
    const off = this.createCanvas()
    off.width = Math.round(w); off.height = Math.round(h)
    off.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, off.width, off.height)

    const pre: Snapshot = { img: this.img, prims: this.prims.map(deepPrim), w: c.width, h: c.height }
    this.img = off
    this.prims = []
    this.current = null
    this.canvas.width = off.width
    this.canvas.height = off.height
    this.tool = 'draw'
    const post: Snapshot = { img: this.img, prims: [], w: off.width, h: off.height }
    // Crop joins the unified undo timeline (below any prims drawn afterwards), so Undo / Ctrl+Z reverses it.
    this.undoStack.push({ op: 'crop', pre, post })
    this.redoStack = []
    this.redraw(); this.onChange()
  }
}
