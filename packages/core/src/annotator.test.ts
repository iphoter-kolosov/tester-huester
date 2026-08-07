import assert from 'node:assert/strict'
import { ImageAnnotator } from './annotator'

// Off-DOM fakes: enough of a canvas/context for the annotator's state logic to run and be asserted.
function makeCtx(): any {
  const ctx: any = { strokeStyle: '', lineWidth: 0, lineJoin: '', lineCap: '', fillStyle: '', font: '', textBaseline: '' }
  for (const m of ['clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'save', 'restore', 'fillRect', 'strokeRect', 'setLineDash', 'closePath', 'fill', 'fillText', 'strokeText', 'arc', 'quadraticCurveTo', 'ellipse']) {
    ctx[m] = () => {}
  }
  return ctx
}
function makeCanvas(w = 0, h = 0): any {
  const cv: any = { width: w, height: h }
  const ctx = makeCtx()
  cv.getContext = () => ctx
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: cv.width, height: cv.height, right: cv.width, bottom: cv.height })
  cv.toDataURL = (type: string) => `${type || 'image/png'}:FAKE`
  return cv
}

let changes = 0
let textReq: [number, number] | null = null
const main = makeCanvas()
const a = new ImageAnnotator(main, {
  createCanvas: () => makeCanvas(),
  onChange: () => { changes++ },
  onTextRequest: (x, y) => { textReq = [x, y] },
})

// 1. apply an image → canvas is sized to it
a.applyImage({ width: 200, height: 150 } as any, 200, 150)
assert.equal(main.width, 200)
assert.equal(main.height, 150)

// 2. freehand → undo/redo (committed on pointerUp)
a.setTool('draw')
a.pointerDown(10, 10); a.pointerMove(50, 50); a.pointerUp()
assert.ok(a.canUndo(), 'freehand recorded')
a.undo()
assert.ok(!a.canUndo() && a.canRedo(), 'undo then redo available')
a.redo()
assert.ok(a.canUndo(), 'redo restored freehand')

// 3. a click with no drag makes no freehand (mis-tap protection)
a.pointerDown(80, 80); a.pointerUp()
assert.equal(a.canRedo(), false, 'no-op tap did not push a redo-clearing add')

// 4. arrow primitive
a.setTool('arrow')
a.pointerDown(10, 10); a.pointerMove(120, 60); a.pointerUp()
assert.ok(a.canUndo(), 'arrow recorded')

// 5. rect primitive
a.setTool('rect')
a.pointerDown(20, 20); a.pointerMove(90, 90); a.pointerUp()
assert.ok(a.canUndo(), 'rect recorded')

// 6. text primitive via the out-of-band callback
a.setTool('text')
a.pointerDown(40, 40)
assert.deepEqual(textReq, [40, 40], 'text tool fired onTextRequest with client coords')
a.addText(40, 40, '  bug here  ')
assert.ok(a.canUndo(), 'text recorded (and trimmed non-empty)')
a.addText(60, 60, '   ') // whitespace-only → ignored
const undosBefore = (() => { let n = 0; while (a.canUndo()) { a.undo(); n++ } return n })()
// undo everything, count primitives that existed: freehand + arrow + rect + text = 4
assert.equal(undosBefore, 4, 'exactly the 4 meaningful primitives were on the stack')
// redo them all back
while (a.canRedo()) a.redo()

// 7. eraser is a brush that sweeps across primitives on drag; drop it on top of the rect edge and it removes it.
a.setTool('eraser')
a.pointerDown(20, 20); a.pointerUp() // point-and-release still erases what is under the brush
assert.ok(a.canUndo(), 'erase is undoable')
a.undo() // restore the erased primitive
assert.ok(a.canRedo(), 'erase can be redone')

// 8. width presets don't throw and are accepted
a.setWidth('thin'); a.setWidth('thick'); a.setWidth('med')

// 9. crop a 100x80 region → canvas resized, tool back to draw, crop is on the unified undo stack
a.setTool('crop')
a.pointerDown(20, 20); a.pointerMove(120, 100); a.pointerUp()
assert.ok(a.canUndo(), 'crop recorded on the undo stack')
assert.equal(main.width, 100, 'canvas cropped width')
assert.equal(main.height, 80, 'canvas cropped height')
assert.equal(a.tool, 'draw', 'tool reset to draw after crop')

// 10. undo (Ctrl+Z) reverses the crop → full frame restored; redo re-applies it
a.undo()
assert.equal(main.width, 200, 'undo restored pre-crop width')
assert.equal(main.height, 150, 'undo restored pre-crop height')
assert.ok(a.canRedo(), 'crop can be redone')
a.redo()
assert.equal(main.width, 100, 'redo re-applied the crop')
a.undo() // back to the full frame for the remaining checks

// 11. a too-small crop drag is ignored (mis-tap protection)
a.setTool('crop')
a.pointerDown(10, 10); a.pointerMove(15, 15); a.pointerUp()
assert.equal(main.width, 200, 'tiny crop ignored — size unchanged')

// 12. clearAll wipes the whole primitive stack
a.setTool('draw')
a.pointerDown(5, 5); a.pointerMove(30, 30); a.pointerUp()
assert.ok(a.canClear(), 'has primitives to clear')
a.clearAll()
assert.ok(!a.canClear() && !a.canUndo(), 'clearAll emptied primitives and undo stack')

// 13. export — JPEG default, PNG option
assert.ok(a.toDataURL().startsWith('image/jpeg'), 'exports a jpeg data URL by default')
assert.ok(a.toDataURL(0.9, 'image/png').startsWith('image/png'), 'PNG export option works')
assert.ok(a.toPNG().startsWith('image/png'), 'toPNG helper works')
assert.ok(changes > 0, 'onChange fired')

// 14. Primitives go out and come back, so a host can persist markup across a page reload and put it back.
a.setTool('rect')
a.pointerDown(10, 10); a.pointerMove(80, 80); a.pointerUp()
a.setTool('arrow')
a.pointerDown(20, 20); a.pointerMove(90, 60); a.pointerUp()
const saved = a.getPrims()
assert.equal(saved.length, 2, 'getPrims returns the current stack')

const live = a.getPrims()
;(live[0] as { color: string }).color = '#123456'
assert.notEqual(a.getPrims()[0]!.color, '#123456', 'getPrims hands out a deep copy, not the live objects')

a.clearAll()
assert.equal(a.getPrims().length, 0, 'cleared')
a.setPrims(saved)
assert.equal(a.getPrims().length, 2, 'setPrims restored the stack')
assert.equal(a.canClear(), true, 'restored primitives count as content')
assert.equal(a.canUndo(), false, 'restored primitives are the baseline — undo cannot go back past them')
assert.equal(a.canRedo(), false, 'and there is nothing to redo into')

// Work done after a restore is undoable, and undo stops at the restored baseline.
a.setTool('draw')
a.pointerDown(5, 5); a.pointerMove(40, 40); a.pointerUp()
assert.equal(a.canUndo(), true, 'new stroke is undoable')
a.undo()
assert.equal(a.getPrims().length, 2, 'undo stopped at the restored baseline')

// Markup is persisted by serialising it, so it has to survive a JSON round trip unchanged — a primitive
// holding anything unserialisable would come back subtly different and the restore would lie.
const throughStorage = JSON.parse(JSON.stringify(a.getPrims()))
assert.deepEqual(throughStorage, a.getPrims(), 'primitives are plain serialisable data')
a.setPrims(throughStorage)
assert.deepEqual(a.getPrims(), throughStorage, 'and load back identically')

// 15. The backdrop can be exported without the markup — the host stores picture and markup separately, so a
//     crop (which changes the picture) survives a restore instead of silently reverting.
assert.ok(a.toBaseDataURL().startsWith('image/jpeg'), 'base export is a jpeg data URL by default')
assert.ok(a.toBaseDataURL(1, 'image/png').startsWith('image/png'), 'base export honours PNG')

console.log('core: all annotator tests passed ✓')
