import assert from 'node:assert/strict'
import { editableTarget, typedText } from './keys'

// The DOM side (stopPropagation at the shadow host, typing a cancelled key back in) is checked in a real browser
// on a page that cancels Space — see docs/DEPLOY-EXTENSION.md. Here: the two decisions it rests on.

type Mods = Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing', boolean>>
const key = (k: string, mods: Mods = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods });

// 1. Printable keys — Space first of all, the one a map site cancelled — are typed; control keys are not.
{
  assert.equal(typedText(key(' ')), ' ')
  assert.equal(typedText(key('a')), 'a')
  assert.equal(typedText(key('ő')), 'ő') // HU layout
  assert.equal(typedText(key('ж')), 'ж') // RU layout
  assert.equal(typedText(key('😀')), '😀') // one code point, two UTF-16 units
  for (const k of ['Enter', 'Backspace', 'Escape', 'Tab', 'ArrowLeft', 'Delete', 'Shift', 'Dead']) assert.equal(typedText(key(k)), null, k)
}

// 2. Shortcuts and IME composition are never retyped — Ctrl+V, Cmd+A must stay the browser's.
{
  assert.equal(typedText(key('v', { ctrlKey: true })), null)
  assert.equal(typedText(key('a', { metaKey: true })), null)
  assert.equal(typedText(key('a', { isComposing: true })), null)
  assert.equal(typedText(key('å', { altKey: true })), 'å') // macOS Option+a types a real character
}

// 3. Only text fields count: a slider or a checkbox in the overlay keeps its keys for the page-less hotkeys.
{
  const ev = (el: object) => ({ composedPath: () => [el], target: el }) as unknown as Event
  assert.ok(editableTarget(ev({ tagName: 'TEXTAREA' })))
  assert.ok(editableTarget(ev({ tagName: 'INPUT', type: 'text' })))
  assert.ok(editableTarget(ev({ tagName: 'INPUT', type: '' }))) // no type attribute = text
  assert.equal(editableTarget(ev({ tagName: 'INPUT', type: 'range' })), null)
  assert.equal(editableTarget(ev({ tagName: 'INPUT', type: 'checkbox' })), null)
  assert.ok(editableTarget(ev({ tagName: 'DIV', isContentEditable: true })))
  assert.equal(editableTarget(ev({ tagName: 'BUTTON', isContentEditable: false })), null)
}

console.log('keys: ok')
