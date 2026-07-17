// Framework-agnostic image annotator: draw, crop (with undo), export. Ported from the eRENTAL 🐞 widget's
// canvas logic and made dependency-free so any client — a browser extension, a React app, anything — can
// drive it. It owns one visible <canvas>; everything else is plain state.

export type Point = { x: number; y: number }
export type Stroke = { color: string; pts: Point[] }
type Drawable = CanvasImageSource & { width: number; height: number }
type Snapshot = { img: Drawable | null; strokes: Stroke[]; w: number; h: number }

export const DEFAULT_COLORS = ['#ff3b30', '#ffcc00', '#0a84ff', '#0c1526']
const MAXPX = 4_000_000 // clamp huge photos so annotation stays crisp and exports stay small

export type AnnotatorOptions = {
  color?: string
  onChange?: () => void
  // Injectable so this is unit-testable off-DOM; defaults to real offscreen canvases in the browser.
  createCanvas?: () => HTMLCanvasElement
}

export class ImageAnnotator {
  color: string
  tool: 'draw' | 'crop' = 'draw'

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private createCanvas: () => HTMLCanvasElement
  private onChange: () => void

  private img: Drawable | null = null
  private strokes: Stroke[] = []
  private redoStack: Stroke[] = []
  private cropHist: Snapshot[] = []
  private cropRect: { x0: number; y0: number; x1: number; y1: number } | null = null
  private drawing = false

  constructor(canvas: HTMLCanvasElement, opts: AnnotatorOptions = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.color = opts.color ?? DEFAULT_COLORS[0]!
    this.onChange = opts.onChange ?? (() => {})
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
    this.strokes = []
    this.redoStack = []
    this.cropHist = []
    this.cropRect = null
    this.tool = 'draw'
    this.redraw()
    this.onChange()
  }

  setColor(c: string): void { this.color = c; if (this.tool !== 'draw') { this.tool = 'draw'; this.redraw() } this.onChange() }
  setTool(t: 'draw' | 'crop'): void { this.tool = t; this.onChange() }

  pointerDown(clientX: number, clientY: number): void {
    const p = this.toCanvasCoords(clientX, clientY)
    this.drawing = true
    if (this.tool === 'crop') { this.cropRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; this.redraw(); return }
    this.redoStack = []
    this.strokes.push({ color: this.color, pts: [p] })
    this.redraw(); this.onChange()
  }
  pointerMove(clientX: number, clientY: number): void {
    if (!this.drawing) return
    const p = this.toCanvasCoords(clientX, clientY)
    if (this.tool === 'crop') { if (this.cropRect) { this.cropRect.x1 = p.x; this.cropRect.y1 = p.y; this.redraw() } return }
    this.strokes[this.strokes.length - 1]!.pts.push(p)
    this.redraw()
  }
  pointerUp(): void {
    if (!this.drawing) return
    this.drawing = false
    if (this.tool === 'crop') { this.finishCrop(); return }
    this.onChange()
  }

  canUndo(): boolean { return this.strokes.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }
  canUndoCrop(): boolean { return this.cropHist.length > 0 }

  undo(): void { const s = this.strokes.pop(); if (s) { this.redoStack.push(s); this.redraw(); this.onChange() } }
  redo(): void { const s = this.redoStack.pop(); if (s) { this.strokes.push(s); this.redraw(); this.onChange() } }
  clearDraw(): void { this.strokes = []; this.redoStack = []; this.redraw(); this.onChange() }

  // Reverse the last crop: restore the pre-crop image AND its strokes and size.
  undoCrop(): void {
    const snap = this.cropHist.pop()
    if (!snap) return
    this.img = snap.img
    this.strokes = snap.strokes.map((st) => ({ color: st.color, pts: [...st.pts] }))
    this.redoStack = []
    this.canvas.width = snap.w
    this.canvas.height = snap.h
    this.tool = 'draw'
    this.redraw(); this.onChange()
  }

  toDataURL(quality = 0.85): string {
    this.redraw()
    return this.canvas.toDataURL('image/jpeg', quality)
  }

  private toCanvasCoords(clientX: number, clientY: number): Point {
    const r = this.canvas.getBoundingClientRect()
    return {
      x: (clientX - r.left) * (this.canvas.width / (r.width || 1)),
      y: (clientY - r.top) * (this.canvas.height / (r.height || 1)),
    }
  }

  private strokeLine(ctx: CanvasRenderingContext2D, st: Stroke): void {
    ctx.strokeStyle = st.color
    ctx.lineWidth = Math.max(2, this.canvas.width / 320)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    st.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.stroke()
  }

  private redraw(): void {
    const c = this.canvas, ctx = this.ctx
    ctx.clearRect(0, 0, c.width, c.height)
    if (this.img) ctx.drawImage(this.img, 0, 0, c.width, c.height)
    for (const st of this.strokes) this.strokeLine(ctx, st)
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

    // Bake image + strokes onto a scratch canvas, lift the region into a new image (no dataURL round-trip).
    const src = this.createCanvas()
    src.width = c.width; src.height = c.height
    const sctx = src.getContext('2d')!
    if (this.img) sctx.drawImage(this.img, 0, 0, c.width, c.height)
    for (const st of this.strokes) this.strokeLine(sctx, st)
    const off = this.createCanvas()
    off.width = Math.round(w); off.height = Math.round(h)
    off.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, off.width, off.height)

    // Remember the whole pre-crop frame so undoCrop restores it.
    this.cropHist.push({ img: this.img, strokes: this.strokes.map((st) => ({ color: st.color, pts: [...st.pts] })), w: c.width, h: c.height })
    this.img = off
    this.strokes = []
    this.redoStack = []
    this.canvas.width = off.width
    this.canvas.height = off.height
    this.tool = 'draw'
    this.redraw(); this.onChange()
  }
}
