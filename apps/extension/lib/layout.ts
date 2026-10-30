// Hotkey layouts, shared by the page overlay and the standalone editor window so a key learnt in one works in
// the other. Keyed off e.code (the PHYSICAL key: 'KeyP', 'Digit1'), never e.key, so the mapping survives any
// keyboard language — physical P is 'з' on the Russian layout.
//   • gamer — CS-style: tools on the number row like weapons, Q/R undo/redo, Z/X/M width. The default: the
//     owner works one-handed on the left side of the keyboard with the mouse in the other hand.
//   • designer — mnemonic letters (R rectangle, A arrow, O oval, P pencil, C crop, T text, E eraser).
import type { Tool, Width } from '@th/core'

export type Layout = 'gamer' | 'designer'

export const LAYOUT_DEFAULT: Layout = 'gamer'
export const LAYOUT_STORE_KEY = 'th.layout'
export const LAYOUT_LABELS: Record<Layout, string> = { gamer: 'Игрок', designer: 'Дизайнер' }

export const TOOL_ORDER: Tool[] = ['rect', 'arrow', 'ellipse', 'draw', 'crop', 'text', 'eraser']

export const TOOL_LAYOUTS: Record<Layout, Record<string, Tool>> = {
  gamer: { Digit1: 'rect', Digit2: 'arrow', Digit3: 'ellipse', Digit4: 'draw', Digit5: 'crop', Digit6: 'text', Digit7: 'eraser' },
  designer: { KeyR: 'rect', KeyA: 'arrow', KeyO: 'ellipse', KeyP: 'draw', KeyC: 'crop', KeyT: 'text', KeyE: 'eraser' },
}
// In gamer mode the digits pick TOOLS, so width moves to the bottom row.
export const WIDTH_LAYOUTS: Record<Layout, Record<string, Width>> = {
  gamer: { KeyZ: 'thin', KeyX: 'med', KeyM: 'thick' },
  designer: { Digit1: 'thin', Digit2: 'med', Digit3: 'thick', Numpad1: 'thin', Numpad2: 'med', Numpad3: 'thick' },
}
// Single-key undo/redo exist only in gamer; Ctrl+Z / Ctrl+Y work in both.
export const UNDO_CODES: Record<Layout, string[]> = { gamer: ['KeyQ'], designer: [] }
export const REDO_CODES: Record<Layout, string[]> = { gamer: ['KeyR'], designer: [] }

const label = (code: string): string => code.replace(/^Key|^Digit/, '')

export function toolKey(layout: Layout, tool: Tool): string {
  const code = Object.entries(TOOL_LAYOUTS[layout]).find(([, t]) => t === tool)?.[0]
  return code ? label(code) : '—'
}

/** "Z / X / M" — the width keys in thin → thick order, numpad duplicates left out. */
export function widthKeys(layout: Layout): string {
  return Object.entries(WIDTH_LAYOUTS[layout]).filter(([c]) => !c.startsWith('Numpad')).map(([c]) => label(c)).join(' / ')
}

/** "1–7" for gamer, "R A O P C T E" for designer: the tools row's caption. */
export function toolKeysShort(layout: Layout): string {
  const keys = TOOL_ORDER.map((t) => toolKey(layout, t))
  return keys.every((k) => /^\d$/.test(k)) ? `${keys[0]}–${keys[keys.length - 1]}` : keys.join(' ')
}

export const isLayout = (v: unknown): v is Layout => v === 'gamer' || v === 'designer'

/** Extension-wide choice. A tester who explicitly picked one keeps it; nobody else is opted into anything. */
export async function loadLayout(): Promise<Layout> {
  const got = await chrome.storage.local.get(LAYOUT_STORE_KEY)
  const v = got[LAYOUT_STORE_KEY]
  return isLayout(v) ? v : LAYOUT_DEFAULT
}

export async function saveLayout(l: Layout): Promise<void> {
  await chrome.storage.local.set({ [LAYOUT_STORE_KEY]: l })
}

/** Fires when the layout is switched in another surface (overlay ↔ editor window). */
export function onLayoutChange(cb: (l: Layout) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const v = changes[LAYOUT_STORE_KEY]?.newValue
    if (area === 'local' && isLayout(v)) cb(v)
  })
}
