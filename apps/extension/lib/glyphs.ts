// The annotation toolbar's visual vocabulary, shared by the in-page overlay (entrypoints/content.ts) and the
// standalone editor window (entrypoints/editor). Two surfaces offering the same seven tools must show the same
// seven pictures — a tester who learns the panel in one place must not have to relearn it in the other.
import type { Tool } from '@th/core'

// Compact tool glyphs — one SVG each, currentColor so a button's own colour drives them. Icons are the shape
// the tool leaves behind (a rectangle, a pointed arrow, a pencil, a marching-ants crop, a T, a slanted eraser)
// so a tester glances at the panel and knows what will happen.
const SVG = (path: string, stroke = false) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="${stroke ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="${stroke ? 1.9 : 0}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`

export const ICON_RECT = SVG('<rect x="4" y="6" width="16" height="12" rx="1.5" ry="1.5" fill="none" stroke="currentColor" stroke-width="2"/>')
export const ICON_ELLIPSE = SVG('<ellipse cx="12" cy="12" rx="8.5" ry="6" fill="none" stroke="currentColor" stroke-width="2"/>')
export const ICON_ARROW = SVG('<path d="M4.5 13.5 L15 13.5 L15 9.5 L20.5 14.5 L15 19.5 L15 15.5 L4.5 15.5 Z"/>')
export const ICON_PENCIL = SVG(
  '<path d="M14.5 4.5 L19.5 9.5 L9 20 L4 20 L4 15 Z" fill="currentColor"/>' +
  '<path d="M13 6 L18 11" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.4"/>' +
  '<path d="M4.6 19.4 L8.6 19.4" fill="none" stroke="rgba(255,255,255,.65)" stroke-width="1.2"/>',
)
export const ICON_CROP = SVG(
  '<path d="M7 3 L7 17 L21 17" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M3 7 L17 7 L17 21" fill="none" stroke="currentColor" stroke-width="2"/>',
)
export const ICON_TEXT = SVG('<path d="M5 5 L19 5 L19 8 L14 8 L14 20 L10 20 L10 8 L5 8 Z"/>')
export const ICON_ERASER = SVG(
  '<path d="M15.5 3.5 L20.5 8.5 L11 18 L4 18 L4 14.5 Z" fill="currentColor"/>' +
  '<path d="M4 20 L20 20" fill="none" stroke="currentColor" stroke-width="2"/>',
)

// The glyph that follows the pointer while a tool is armed (the system cursor is hidden under it). The eraser
// is absent on purpose: its on-canvas brush ring already IS its cursor.
export const TOOL_CURSORS: Record<Exclude<Tool, 'eraser'>, string> = {
  rect:    '<svg viewBox="0 0 22 22"><path class="shadow" d="M11 4v14 M4 11h14"/><path class="stroke" d="M11 4v14 M4 11h14"/><rect x="7" y="7" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  arrow:   '<svg viewBox="0 0 22 22"><path class="shadow" d="M11 4v14 M4 11h14"/><path class="stroke" d="M11 4v14 M4 11h14"/><path class="fill" d="M15 8 L19 12 L15 16 L15 13 L11 13 L11 11 L15 11 Z"/></svg>',
  ellipse: '<svg viewBox="0 0 22 22"><path class="shadow" d="M11 4v14 M4 11h14"/><path class="stroke" d="M11 4v14 M4 11h14"/><ellipse cx="11" cy="11" rx="5" ry="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  text:    '<svg viewBox="0 0 22 22"><path class="shadow" d="M8 4h6 M8 18h6 M11 4v14"/><path class="stroke" d="M8 4h6 M8 18h6 M11 4v14"/></svg>',
  crop:    '<svg viewBox="0 0 22 22"><path class="shadow" d="M8 2v13h13 M2 8h13v13"/><path class="stroke" d="M8 2v13h13 M2 8h13v13"/></svg>',
  draw:    '<svg viewBox="0 0 22 22"><path class="fill" d="M14 3 L19 8 L8 19 L3 19 L3 14 Z"/><path d="M3 19 L6 19" stroke="#38bdf8" stroke-width="1.5"/></svg>',
}

// Human labels for the seven tools, used in tooltips on both surfaces.
export const TOOL_LABELS: Record<Tool, string> = {
  rect: 'Рамка', arrow: 'Стрелка', ellipse: 'Овал', draw: 'Карандаш', crop: 'Кадрирование', text: 'Текст', eraser: 'Ластик',
}
