import assert from 'node:assert/strict'
import { LAYOUT_DEFAULT, TOOL_LAYOUTS, TOOL_ORDER, WIDTH_LAYOUTS, UNDO_CODES, REDO_CODES, toolKey, toolKeysShort, widthKeys, isLayout } from './layout'

// The owner's default: a tester who never touched the picker gets the player layout.
assert.equal(LAYOUT_DEFAULT, 'gamer')

// Captions are derived from the bindings, so what the cheat sheet says is what the key does.
assert.equal(toolKeysShort('gamer'), '1–7')
assert.equal(toolKeysShort('designer'), 'R A O P C T E')
assert.equal(widthKeys('gamer'), 'Z / X / M')
assert.equal(widthKeys('designer'), '1 / 2 / 3')
assert.equal(toolKey('gamer', 'eraser'), '7')
assert.equal(toolKey('designer', 'draw'), 'P')

// Within a layout no physical key is bound twice — a tool key that also undoes would eat one of the two.
for (const l of ['gamer', 'designer'] as const) {
  const codes = [...Object.keys(TOOL_LAYOUTS[l]), ...Object.keys(WIDTH_LAYOUTS[l]), ...UNDO_CODES[l], ...REDO_CODES[l], 'KeyF']
  assert.equal(new Set(codes).size, codes.length, `duplicate key in ${l}`)
  for (const t of TOOL_ORDER) assert.notEqual(toolKey(l, t), '—', `${t} unbound in ${l}`)
}

assert.ok(isLayout('gamer') && isLayout('designer') && !isLayout('Designer') && !isLayout(null))
console.log('layout: ok')
