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
export type EllipsePrim = { kind: 'ellipse'; color: string; width: Width; a: Point; b: Point }
export type TextPrim = { kind: 'text'; color: string; p: Point; str: string; size: number }
export type Prim = Freehand | Arrow | RectPrim | EllipsePrim | TextPrim

// Back-compat alias: the old model was a single freehand stroke. Old imports keep working.
export type Stroke = Freehand

export type Tool = 'draw' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'eraser' | 'crop'

// Undo/redo works over a command log so erasing (which removes a primitive from the middle of the stack) is
// reversible in the same stack as adding.
type Cmd = { op: 'add'; prim: Prim } | { op: 'erase'; prim: Prim; index: number } | { op: 'crop'; pre: Snapshot; post: Snapshot }

type Drawable = CanvasImageSource & { width: number; height: number }
type Snapshot = { img: Drawable | null; prims: Prim[]; w: number; h: number }

// Annotation palette. Red leads because it is the default marker; the rest are picked to stay distinguishable
// on both light and dark screenshots (and from each other for viewers with colour-vision deficiency).
export const DEFAULT_COLORS = [
  '#ff3b30', // red
  '#ff9500', // orange
  '#ffcc00', // yellow
  '#34c759', // green
  '#00c7be', // teal
  '#0a84ff', // blue
  '#5856d6', // indigo
  '#af52de', // purple
  '#ff2d55', // pink
  '#ffffff', // white
  '#8e8e93', // grey
  '#0c1526', // near-black
]
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
    case 'ellipse': return { ...p, a: { ...p.a }, b: { ...p.b } }
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
  // Rectangle is the default: the overwhelmingly common annotation is "look at THIS box", and a stray
  // pencil stroke from a mis-click is noisier than a stray rectangle.
  tool: Tool = 'rect'

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
  private erasePath: Point[] = [] // brush trail while dragging the eraser — drawn as a soft ring for feedback

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
  // `keepAnnotations` swaps only the backdrop: the tester's arrows and notes survive. Used when the overlay
  // refreshes the screenshot mid-session (after recording a repro) — losing their markup there is a real loss
  // of work, not a cosmetic reset.
  setImage(dataUrl: string, keepAnnotations = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => { this.applyImage(im, im.naturalWidth, im.naturalHeight, keepAnnotations); resolve() }
      im.onerror = () => reject(new Error('image decode failed'))
      im.src = dataUrl
    })
  }

  applyImage(src: Drawable, naturalW: number, naturalH: number, keepAnnotations = false): void {
    const scale = Math.min(1, Math.sqrt(MAXPX / Math.max(1, naturalW * naturalH)))
    this.canvas.width = Math.max(1, Math.round(naturalW * scale))
    this.canvas.height = Math.max(1, Math.round(naturalH * scale))
    this.img = src
    if (!keepAnnotations) {
      this.prims = []
      this.undoStack = []
      this.redoStack = []
      this.tool = 'rect'
    }
    this.cropRect = null
    this.current = null
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
    if (this.tool === 'eraser') { this.drawing = true; this.erasePath = [p]; this.eraseSweep(p, p); return }
    this.drawing = true
    if (this.tool === 'arrow') this.current = { kind: 'arrow', color: this.color, width: this.width, a: p, b: { ...p } }
    else if (this.tool === 'rect') this.current = { kind: 'rect', color: this.color, width: this.width, a: p, b: { ...p } }
    else if (this.tool === 'ellipse') this.current = { kind: 'ellipse', color: this.color, width: this.width, a: p, b: { ...p } }
    else this.current = { kind: 'freehand', color: this.color, width: this.width, pts: [p] }
    this.redraw()
  }

  pointerMove(clientX: number, clientY: number): void {
    if (!this.drawing) return
    const p = this.toCanvasCoords(clientX, clientY)
    if (this.tool === 'crop') { if (this.cropRect) { this.cropRect.x1 = p.x; this.cropRect.y1 = p.y; this.redraw() } return }
    if (this.tool === 'eraser') {
      // Point-and-drag eraser: sweeps a brush-sized band; every primitive whose distance to the swept segment
      // falls under the brush radius is removed. The path is remembered so the tester sees where they went.
      const last = this.erasePath.at(-1) ?? p
      this.eraseSweep(last, p)
      this.erasePath.push(p)
      this.redraw()
      return
    }
    const cur = this.current
    if (!cur) return
    if (cur.kind === 'freehand') cur.pts.push(p)
    else if (cur.kind === 'arrow' || cur.kind === 'rect' || cur.kind === 'ellipse') cur.b = p
    this.redraw()
  }

  pointerUp(): void {
    if (!this.drawing) return
    this.drawing = false
    if (this.tool === 'crop') { this.finishCrop(); return }
    if (this.tool === 'eraser') { this.erasePath = []; this.redraw(); return }
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

  // Markup in and out, as plain data. The host persists this next to the screenshot so a page reload under the
  // overlay (a dev server rebuilding, a crash) costs the tester nothing. Deep copies both ways: the caller may
  // serialise, mutate or hold onto the array without reaching into the live stack.
  getPrims(): Prim[] { return this.prims.map(deepPrim) }

  // Restored primitives are the new BASELINE: undo/redo start empty, so Ctrl+Z after a restore cannot rewind
  // into a history that no longer exists (the commands that produced these primitives died with the page).
  setPrims(prims: Prim[]): void {
    this.prims = prims.map(deepPrim)
    this.undoStack = []
    this.redoStack = []
    this.current = null
    this.redraw(); this.onChange()
  }

  // The backdrop alone, with no primitives painted on it. Lets a host store "the picture" separately from
  // "the markup" — needed because a crop replaces the picture, and re-restoring the original screenshot would
  // silently undo it.
  toBaseDataURL(quality = 0.85, type: 'image/jpeg' | 'image/png' = 'image/jpeg'): string {
    const off = this.createCanvas()
    off.width = this.canvas.width
    off.height = this.canvas.height
    if (this.img) off.getContext('2d')!.drawImage(this.img, 0, 0, off.width, off.height)
    return type === 'image/png' ? off.toDataURL('image/png') : off.toDataURL('image/jpeg', quality)
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

  // Sweep-erase: remove every primitive whose distance to the swept segment falls under the brush radius.
  // The brush size follows the width preset — thin/med/thick — so the eraser inherits the same "how big is
  // my mark" control as the drawing tools; the tester adjusts it once and it applies to both.
  private eraseSweep(a: Point, b: Point): void {
    const r = this.brushRadius()
    let removedAny = false
    for (let i = this.prims.length - 1; i >= 0; i--) {
      if (this.distFromPrimToSeg(this.prims[i]!, a, b) < r) {
        const prim = this.prims.splice(i, 1)[0]!
        this.undoStack.push({ op: 'erase', prim, index: i })
        removedAny = true
      }
    }
    if (removedAny) { this.redoStack = []; this.onChange() }
  }

  private brushRadius(): number {
    // A useful eraser is a bit larger than the ink it removes so you don't have to trace exactly.
    return this.pxWidth(this.width) * 3.2 + 6
  }

  private distFromPrimToSeg(prim: Prim, a: Point, b: Point): number {
    // Closest distance between the primitive's line/vertices and the eraser sweep — good enough for a hit
    // test at UI speeds without pixel readback.
    switch (prim.kind) {
      case 'arrow':
      case 'rect':
      case 'ellipse': {
        const p = prim as Arrow | RectPrim | EllipsePrim
        // Sample corners + midpoints of the primitive; segment-to-segment is overkill for a UI eraser.
        const pts: Point[] = [p.a, p.b, { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }]
        let m = Infinity
        for (const q of pts) m = Math.min(m, distToSeg(q, a, b))
        return m
      }
      case 'freehand': {
        let m = Infinity
        for (const q of prim.pts) m = Math.min(m, distToSeg(q, a, b))
        return m
      }
      case 'text': {
        const q = prim.p
        return distToSeg(q, a, b) - (prim.size || 12) * 0.5
      }
    }
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
      case 'ellipse': {
        const cx = (prim.a.x + prim.b.x) / 2, cy = (prim.a.y + prim.b.y) / 2
        const rx = Math.max(1, Math.abs(prim.b.x - prim.a.x) / 2), ry = Math.max(1, Math.abs(prim.b.y - prim.a.y) / 2)
        // Approximate distance-to-ellipse via the normalised deviation of the point from the ellipse boundary.
        const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry
        const r = Math.hypot(nx, ny) || 1
        return Math.abs(r - 1) * Math.min(rx, ry)
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
    if (prim.kind === 'arrow' || prim.kind === 'rect' || prim.kind === 'ellipse') return Math.hypot(prim.b.x - prim.a.x, prim.b.y - prim.a.y) >= 5
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
        // Draw as a Catmull-Rom → quadratic Bézier chain: the raw pointer samples are jittery, and connecting
        // them with straight lines makes deliberate strokes look wobbly. Bézier segments interpolate through
        // each sample smoothly, so the stroke reads as one calm line without changing what the tester drew.
        ctx.strokeStyle = prim.color
        ctx.lineWidth = this.pxWidth(prim.width)
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        const pts = prim.pts
        ctx.beginPath()
        if (pts.length < 2) {
          // A single sample: draw a dot so a click still leaves ink.
          const p = pts[0]!
          ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2)
          ctx.fill()
          break
        }
        ctx.moveTo(pts[0]!.x, pts[0]!.y)
        for (let i = 1; i < pts.length - 1; i++) {
          const p = pts[i]!, n = pts[i + 1]!
          ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2)
        }
        const last = pts[pts.length - 1]!
        ctx.lineTo(last.x, last.y)
        ctx.stroke()
        break
      }
      case 'arrow': {
        // One filled silhouette instead of a stroked line plus a small triangle: the shaft tapers from a fine
        // tail into a broad head, so the arrow reads as a deliberate pointer at any size — the stroke+triangle
        // version left the line poking through the head and looked flimsy.
        const lw = this.pxWidth(prim.width)
        const dx = prim.b.x - prim.a.x, dy = prim.b.y - prim.a.y
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len, uy = dy / len // along the arrow
        const nx = -uy, ny = ux // perpendicular

        const headLen = Math.min(len * 0.42, Math.max(16, lw * 4.2))
        const headHalf = Math.max(10, lw * 2.6)
        const tailHalf = Math.max(1.1, lw * 0.42)
        const neckHalf = Math.max(1.8, lw * 0.72)
        const nx0 = prim.b.x - ux * headLen, ny0 = prim.b.y - uy * headLen // where the head begins

        const P = (px: number, py: number, s: number) => [px + nx * s, py + ny * s] as const
        ctx.beginPath()
        ctx.moveTo(...P(prim.a.x, prim.a.y, tailHalf))
        ctx.lineTo(...P(nx0, ny0, neckHalf))
        ctx.lineTo(...P(nx0, ny0, headHalf))
        ctx.lineTo(prim.b.x, prim.b.y) // the tip
        ctx.lineTo(...P(nx0, ny0, -headHalf))
        ctx.lineTo(...P(nx0, ny0, -neckHalf))
        ctx.lineTo(...P(prim.a.x, prim.a.y, -tailHalf))
        ctx.closePath()
        ctx.fillStyle = prim.color
        ctx.lineJoin = 'round'
        // A hairline dark edge keeps the arrow legible over same-coloured UI.
        ctx.strokeStyle = 'rgba(0,0,0,.35)'
        ctx.lineWidth = Math.max(1, lw * 0.16)
        ctx.fill()
        ctx.stroke()
        break
      }
      case 'rect': {
        const x = Math.min(prim.a.x, prim.b.x), y = Math.min(prim.a.y, prim.b.y)
        const w = Math.abs(prim.b.x - prim.a.x), h = Math.abs(prim.b.y - prim.a.y)
        ctx.strokeStyle = prim.color; ctx.lineWidth = this.pxWidth(prim.width); ctx.lineJoin = 'miter'
        ctx.strokeRect(x, y, w, h)
        break
      }
      case 'ellipse': {
        // Same bounding-rect gesture as the rectangle: the ellipse fits inside the drag box, so a diagonal
        // stroke gives an oval and a square drag gives a circle — no extra modifier keys.
        const cx = (prim.a.x + prim.b.x) / 2, cy = (prim.a.y + prim.b.y) / 2
        const rx = Math.abs(prim.b.x - prim.a.x) / 2, ry = Math.abs(prim.b.y - prim.a.y) / 2
        ctx.strokeStyle = prim.color; ctx.lineWidth = this.pxWidth(prim.width); ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2)
        ctx.stroke()
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
    // Eraser brush trail — visible feedback while the tester wipes something out.
    if (this.tool === 'eraser' && this.erasePath.length) {
      const r = this.brushRadius()
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,.9)'
      ctx.lineWidth = 1.5
      ctx.fillStyle = 'rgba(255,255,255,.14)'
      ctx.beginPath()
      const p = this.erasePath[this.erasePath.length - 1]!
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
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
