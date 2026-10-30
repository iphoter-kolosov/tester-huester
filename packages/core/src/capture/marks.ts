import type { Prim } from '../annotator.js'
import type { SelectorCandidates } from './types.js'

// What each mark on the screenshot points at ON THE LIVE PAGE. A tester circles a button and writes "this is
// broken"; the agent gets a picture and has to guess which element of the DOM that is. Marker.io / Faster Fixes
// make the tester switch to an "element picker" and click again. We already have the answer: the page is still
// under the overlay exactly as it was photographed, so every rectangle, oval, arrow tip and text label maps to
// screen coordinates, and the browser can say what is there — no extra click.

export type MarkedElement = {
  n: number // 1-based, in the order the marks were drawn — "mark 2" means the same thing to tester and agent
  mark: 'rect' | 'ellipse' | 'arrow' | 'freehand' | 'text'
  color: string
  label?: string // the text of a text mark, or nothing
  at: { x: number; y: number; w: number; h: number } // the mark in page CSS px (viewport-relative at capture)
  tag: string
  selector: SelectorCandidates
  box: { x: number; y: number; w: number; h: number } // the chosen element, same coordinate space
}

export type Box = { x: number; y: number; w: number; h: number }
export type Candidate = { tag: string; box: Box; selector: () => SelectorCandidates }

const MAX_MARKS = 30

/** The region a mark covers on the image, in IMAGE pixels; arrows and text collapse to the point they name. */
export function markRegion(p: Prim): { mark: MarkedElement['mark']; r: Box; point: boolean } {
  const box = (ax: number, ay: number, bx: number, by: number): Box =>
    ({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) })
  switch (p.kind) {
    case 'rect': return { mark: 'rect', r: box(p.a.x, p.a.y, p.b.x, p.b.y), point: false }
    case 'ellipse': return { mark: 'ellipse', r: box(p.a.x, p.a.y, p.b.x, p.b.y), point: false }
    // The arrow's HEAD is what it points at; the tail is wherever the hand started.
    case 'arrow': return { mark: 'arrow', r: { x: p.b.x, y: p.b.y, w: 0, h: 0 }, point: true }
    case 'text': return { mark: 'text', r: { x: p.p.x, y: p.p.y, w: 0, h: 0 }, point: true }
    case 'freehand': {
      const xs = p.pts.map((q) => q.x), ys = p.pts.map((q) => q.y)
      return { mark: 'freehand', r: box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)), point: false }
    }
  }
}

const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h)
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Which of the elements stacked under a mark's centre (topmost first, as document.elementsFromPoint gives
 * them) the tester meant. For a point mark — the topmost. For an area — the element that best FILLS the area:
 * circling a card means the card, not the word in its middle and not the page around it. Score = how much of
 * the mark the element covers × how much of the element lies inside the mark (both ∈ [0,1]).
 */
export function pickElement(region: Box, point: boolean, stack: Candidate[]): Candidate | null {
  if (!stack.length) return null
  if (point || area(region) < 16) return stack[0]!
  let best: Candidate | null = null
  let bestScore = -1
  for (const c of stack) {
    const ov = overlap(region, c.box)
    if (!ov || !area(c.box)) continue
    const score = (ov / area(region)) * (ov / area(c.box))
    if (score > bestScore + 1e-9) { best = c; bestScore = score }
  }
  return best ?? stack[0]!
}

/**
 * Map every mark to the element under it. `scale` = image px per CSS px (the screenshot is taken at
 * devicePixelRatio); `stackAt` returns the candidates under a CSS point, topmost first.
 */
export function markElements(prims: Prim[], scale: number, stackAt: (x: number, y: number) => Candidate[]): MarkedElement[] {
  const out: MarkedElement[] = []
  const s = scale > 0 ? scale : 1
  for (const p of prims) {
    if (out.length >= MAX_MARKS) break
    const { mark, r, point } = markRegion(p)
    const at = { x: r.x / s, y: r.y / s, w: r.w / s, h: r.h / s }
    const pick = pickElement(at, point, stackAt(at.x + at.w / 2, at.y + at.h / 2))
    if (!pick) continue
    const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })
    out.push({
      n: out.length + 1,
      mark,
      color: p.color,
      ...(p.kind === 'text' ? { label: p.str } : {}),
      at: round(at),
      tag: pick.tag,
      selector: pick.selector(),
      box: round(pick.box),
    })
  }
  return out
}

/** One line per mark, for a human or an agent reading the ticket. */
export function describeMarks(marks: MarkedElement[]): string[] {
  const what: Record<MarkedElement['mark'], string> = { rect: 'frame', ellipse: 'oval', arrow: 'arrow', freehand: 'scribble', text: 'text' }
  return marks.map((m) => {
    const s = m.selector
    const name = s.testid ? `[data-testid="${s.testid}"]` : s.role && s.name ? `${s.role} "${s.name}"` : s.text ? `<${m.tag}> "${s.text}"` : `<${m.tag}>`
    const label = m.label ? ` labelled "${m.label}"` : ''
    return `Mark ${m.n} (${what[m.mark]}${label}) → ${name} · css: ${s.css}`
  })
}
