import assert from 'node:assert/strict'
import { ImageAnnotator } from './annotator'

// Off-DOM fakes: enough of a canvas/context for the annotator's state logic to run and be asserted.
function makeCtx(): any {
  const ctx: any = { strokeStyle: '', lineWidth: 0, lineJoin: '', lineCap: '', fillStyle: '' }
  for (const m of ['clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'save', 'restore', 'fillRect', 'strokeRect', 'setLineDash']) {
    ctx[m] = () => {}
  }
  return ctx
}
function makeCanvas(w = 0, h = 0): any {
  const cv: any = { width: w, height: h }
  const ctx = makeCtx()
  cv.getContext = () => ctx
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: cv.width, height: cv.height, right: cv.width, bottom: cv.height })
  cv.toDataURL = () => 'data:image/jpeg;base64,FAKE'
  return cv
}

let changes = 0
const main = makeCanvas()
const a = new ImageAnnotator(main, { createCanvas: () => makeCanvas(), onChange: () => { changes++ } })

// 1. apply an image → canvas is sized to it
a.applyImage({ width: 200, height: 150 } as any, 200, 150)
assert.equal(main.width, 200)
assert.equal(main.height, 150)

// 2. draw a stroke → undo/redo
a.setTool('draw')
a.pointerDown(10, 10); a.pointerMove(50, 50); a.pointerUp()
assert.ok(a.canUndo(), 'stroke recorded')
a.undo()
assert.ok(!a.canUndo() && a.canRedo(), 'undo then redo available')
a.redo()
assert.ok(a.canUndo(), 'redo restored stroke')

// 3. crop a 100x80 region → canvas resized, tool back to draw, crop is undoable
a.setTool('crop')
a.pointerDown(20, 20); a.pointerMove(120, 100); a.pointerUp()
assert.ok(a.canUndoCrop(), 'crop recorded in history')
assert.equal(main.width, 100, 'canvas cropped width')
assert.equal(main.height, 80, 'canvas cropped height')
assert.equal(a.tool, 'draw', 'tool reset to draw after crop')

// 4. undo the crop → full frame restored
a.undoCrop()
assert.equal(main.width, 200, 'undoCrop restored width')
assert.equal(main.height, 150, 'undoCrop restored height')
assert.ok(!a.canUndoCrop(), 'crop history emptied')

// 5. a too-small crop drag is ignored (mis-tap protection)
a.setTool('crop')
a.pointerDown(10, 10); a.pointerMove(15, 15); a.pointerUp()
assert.ok(!a.canUndoCrop(), 'tiny crop ignored')

// 6. export
assert.ok(a.toDataURL().startsWith('data:image/jpeg'), 'exports a jpeg data URL')
assert.ok(changes > 0, 'onChange fired')

console.log('core: all annotator tests passed ✓')
