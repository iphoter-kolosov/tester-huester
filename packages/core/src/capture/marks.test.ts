import assert from 'node:assert/strict'
import { markElements, pickElement, describeMarks, type Candidate } from './marks'
import type { Prim } from '../annotator'

const el = (tag: string, x: number, y: number, w: number, h: number, sel: Record<string, string> = {}): Candidate =>
  ({ tag, box: { x, y, w, h }, selector: () => ({ css: sel.css ?? tag, ...sel }) })

// A page: body ⊃ card (100,100 300×200) ⊃ button (120,250 80×30) ⊃ its label word.
const body = el('body', 0, 0, 1280, 2000)
const card = el('div', 100, 100, 300, 200, { css: '.card' })
const button = el('button', 120, 250, 80, 30, { css: '.buy', role: 'button', name: 'Купить' })
const word = el('span', 130, 255, 40, 20, { css: '.buy span', text: 'Купить' })

// 1. Circling the card picks the card — not the word under the centre, not the page.
{
  const stack = [word, button, card, body]
  assert.equal(pickElement({ x: 95, y: 95, w: 310, h: 210 }, false, stack)?.box, card.box)
  // A tight frame around the button picks the button.
  assert.equal(pickElement({ x: 118, y: 248, w: 84, h: 34 }, false, stack)?.box, button.box)
}

// 2. An arrow names what its HEAD touches — the topmost element there; image px are divided by the DPR.
{
  const prims: Prim[] = [{ kind: 'arrow', color: '#f00', width: 'med', a: { x: 0, y: 0 }, b: { x: 300, y: 530 } }]
  let asked: [number, number] | null = null
  const marks = markElements(prims, 2, (x, y) => { asked = [x, y]; return [word, button, card, body] })
  assert.deepEqual(asked, [150, 265])
  assert.equal(marks[0]!.n, 1)
  assert.equal(marks[0]!.mark, 'arrow')
  assert.equal(marks[0]!.selector.css, '.buy span')
}

// 3. Text marks carry their words; nothing under a mark → the mark is skipped, numbering stays dense.
{
  const prims: Prim[] = [
    { kind: 'text', color: '#0f0', p: { x: 10, y: 10 }, str: 'тут', size: 16 },
    { kind: 'rect', color: '#f00', width: 'med', a: { x: 118, y: 248 }, b: { x: 202, y: 282 } },
  ]
  const marks = markElements(prims, 1, (x) => (x < 50 ? [] : [word, button, card, body]))
  assert.equal(marks.length, 1)
  assert.equal(marks[0]!.n, 1)
  assert.equal(describeMarks(marks)[0], 'Mark 1 (frame) → button "Купить" · css: .buy')
}

// 4. A runaway markup is capped, so a report cannot balloon on scribbles.
{
  const many: Prim[] = Array.from({ length: 50 }, () => ({ kind: 'arrow', color: '#f00', width: 'thin', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }) as Prim)
  assert.equal(markElements(many, 1, () => [body]).length, 30)
}

console.log('core: marks tests passed ✓')
