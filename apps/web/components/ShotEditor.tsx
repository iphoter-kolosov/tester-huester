'use client'
import { useEffect, useRef, useState } from 'react'
// Subpath import: the core barrel pulls the capture chain (with Node-style .js specifiers) that webpack can't
// resolve in a client bundle. The annotator has no such dependency, so importing it directly stays clean.
import { ImageAnnotator, DEFAULT_COLORS, type Tool, type Width } from '@th/core/annotator'

// Draw over the ticket's screenshot from the DASHBOARD (agents and humans) — same primitives, palette and
// sliders as the extension overlay. The result is uploaded as its own image and inserted into the comment
// draft as an inline markdown reference, so an editorial round-trip ("look, here's what I mean") is one
// modal, not a screenshot + a paint program + a copy-paste.
//
// The engine is the framework-agnostic `ImageAnnotator` from @th/core; this file is only the React shell
// around it. Nothing here duplicates drawing logic.

type Props = {
  imageUrl: string
  reportId: string
  onClose: () => void
  onInsert: (markdownLink: string) => void
}

// Live tool cursor glyphs — matched to the extension so the muscle memory carries over.
const TOOL_CURSORS: Record<Exclude<Tool, 'eraser'>, string> = {
  rect:    '<svg viewBox="0 0 22 22"><path d="M11 4v14 M4 11h14" stroke="#0b1220" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M11 4v14 M4 11h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="7" y="7" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  arrow:   '<svg viewBox="0 0 22 22"><path d="M11 4v14 M4 11h14" stroke="#0b1220" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M11 4v14 M4 11h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M15 8 L19 12 L15 16 L15 13 L11 13 L11 11 L15 11 Z" fill="currentColor" stroke="#0b1220" stroke-width="0.8"/></svg>',
  ellipse: '<svg viewBox="0 0 22 22"><path d="M11 4v14 M4 11h14" stroke="#0b1220" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M11 4v14 M4 11h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><ellipse cx="11" cy="11" rx="5" ry="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  text:    '<svg viewBox="0 0 22 22"><path d="M8 4h6 M8 18h6 M11 4v14" stroke="#0b1220" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M8 4h6 M8 18h6 M11 4v14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  crop:    '<svg viewBox="0 0 22 22"><path d="M8 2v13h13 M2 8h13v13" stroke="#0b1220" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M8 2v13h13 M2 8h13v13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  draw:    '<svg viewBox="0 0 22 22"><path d="M14 3 L19 8 L8 19 L3 19 L3 14 Z" fill="currentColor" stroke="#0b1220" stroke-width="1"/><path d="M3 19 L6 19" stroke="#38bdf8" stroke-width="1.5"/></svg>',
}

const TOOLS: { key: Tool; label: string; hot: string; svg: string }[] = [
  { key: 'rect', label: 'Рамка', hot: 'R', svg: '<rect x="4" y="6" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>' },
  { key: 'arrow', label: 'Стрелка', hot: 'A', svg: '<path d="M4.5 13.5H15V9.5L20.5 14.5 15 19.5V15.5H4.5z" fill="currentColor"/>' },
  { key: 'ellipse', label: 'Овал', hot: 'O', svg: '<ellipse cx="12" cy="12" rx="8.5" ry="6" fill="none" stroke="currentColor" stroke-width="2"/>' },
  { key: 'draw', label: 'Карандаш', hot: 'P', svg: '<path d="M14 3l5 5-11 11H3v-5z" fill="currentColor"/>' },
  { key: 'crop', label: 'Кадрирование', hot: 'C', svg: '<path d="M7 3v13h13M3 7h13v13" fill="none" stroke="currentColor" stroke-width="2"/>' },
  { key: 'text', label: 'Текст', hot: 'T', svg: '<path d="M5 5h14v3h-5v12h-4V8H5z" fill="currentColor"/>' },
  { key: 'eraser', label: 'Ластик', hot: 'E', svg: '<path d="M15.5 3.5l5 5L11 18H4v-3.5z" fill="currentColor"/><path d="M4 20h16" stroke="currentColor" stroke-width="2"/>' },
]

export default function ShotEditor({ imageUrl, reportId, onClose, onInsert }: Props) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const annRef = useRef<ImageAnnotator | null>(null)
  const tcurRef = useRef<HTMLDivElement>(null) // live tool glyph following the pointer
  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState(DEFAULT_COLORS[0]!)
  const [width, setWidth] = useState<Width>('med')
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Text-input popup for the T tool — same UX as the extension: click marks a point, small input opens next
  // to it, Enter commits, Esc cancels.
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null)
  const textInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return
    // Reuse the extension's engine 1:1 — undo/redo, crop, colour, width, primitives, all identical.
    const ann = new ImageAnnotator(cv, {
      onChange: () => {
        setCanUndo(ann.canUndo())
        setCanRedo(ann.canRedo())
        // The tool can change from inside the engine (crop finishes → 'rect'), so keep the React mirror in sync
        // instead of drifting silently.
        setTool(ann.tool)
        setColor(ann.color)
      },
      onTextRequest: (x, y) => setTextAt({ x, y }),
    })
    annRef.current = ann
    ann.setImage(imageUrl).catch(() => setErr('Не удалось загрузить изображение'))

    // Pointer wiring — the engine is UI-agnostic and does not attach its own listeners, so this file must.
    // Text and eraser are single-tap / brush and setting pointer capture would steal focus from the text input
    // (and prevent the eraser sweep from leaving the canvas cleanly), so those two skip capture.
    const down = (e: PointerEvent) => {
      if (ann.tool !== 'text' && ann.tool !== 'eraser') cv.setPointerCapture(e.pointerId)
      ann.pointerDown(e.clientX, e.clientY)
    }
    const move = (e: PointerEvent) => {
      ann.pointerMove(e.clientX, e.clientY)
      // Live tool glyph following the pointer — same feel as the extension overlay.
      const t = tcurRef.current
      if (t) { t.style.left = e.clientX + 'px'; t.style.top = e.clientY + 'px' }
    }
    const up = () => ann.pointerUp()
    const enter = () => { if (ann.tool !== 'eraser') tcurRef.current?.classList.add('on') }
    const leave = () => { tcurRef.current?.classList.remove('on'); ann.pointerUp() }
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointerenter', enter)
    cv.addEventListener('pointerleave', leave)

    // Fit the canvas element into the stage (the canvas has real pixel dims after setImage; CSS scales it).
    const fit = () => {
      if (!stageRef.current) return
      const sw = stageRef.current.clientWidth - 4
      const sh = stageRef.current.clientHeight - 4
      const scale = Math.min(1, sw / (cv.width || 1), sh / (cv.height || 1))
      cv.style.width = `${Math.round((cv.width || 1) * scale)}px`
      cv.style.height = `${Math.round((cv.height || 1) * scale)}px`
    }
    const ro = new ResizeObserver(fit)
    if (stageRef.current) ro.observe(stageRef.current)
    // The image decodes asynchronously — refit a few times so the newly-sized canvas fits its box regardless.
    const t1 = setTimeout(fit, 60)
    const t2 = setTimeout(fit, 250)
    return () => {
      ro.disconnect()
      clearTimeout(t1); clearTimeout(t2)
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointerenter', enter)
      cv.removeEventListener('pointerleave', leave)
    }
  }, [imageUrl])

  // Push tool/color/width from React state into the engine on every change.
  useEffect(() => { annRef.current?.setTool(tool) }, [tool])
  useEffect(() => { annRef.current?.setColor(color) }, [color])
  useEffect(() => { annRef.current?.setWidth(width) }, [width])

  // Hotkeys — mirror the extension's designer layout so the tester never learns a second scheme.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'TEXTAREA'
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.code === 'KeyZ') { if (typing) return; e.preventDefault(); if (e.shiftKey) annRef.current?.redo(); else annRef.current?.undo(); return }
      if (mod && e.code === 'KeyY') { if (typing) return; e.preventDefault(); annRef.current?.redo(); return }
      if (mod && e.code === 'Enter') { e.preventDefault(); void save(true); return }
      if (mod) return
      if (e.code === 'Escape') { if (textAt) { setTextAt(null); return } e.preventDefault(); onClose(); return }
      if (typing) return
      if (e.shiftKey && (e.code === 'Delete' || e.code === 'Backspace')) { e.preventDefault(); annRef.current?.clearAll(); return }
      const map: Record<string, Tool> = { KeyR: 'rect', KeyA: 'arrow', KeyO: 'ellipse', KeyP: 'draw', KeyC: 'crop', KeyT: 'text', KeyE: 'eraser' }
      const t = map[e.code]
      if (t) { e.preventDefault(); setTool(t); return }
      const w: Record<string, Width> = { Digit1: 'thin', Digit2: 'med', Digit3: 'thick' }
      if (w[e.code]) { e.preventDefault(); setWidth(w[e.code]!) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [textAt, onClose])

  function commitText() {
    const ann = annRef.current
    const s = textInput.current?.value ?? ''
    if (ann && textAt && s.trim()) ann.addText(textAt.x, textAt.y, s)
    setTextAt(null)
  }

  async function save(insert: boolean) {
    const ann = annRef.current
    if (!ann) return
    setBusy(true)
    setErr('')
    try {
      const data = ann.toDataURL(0.85)
      const res = await fetch(`/api/reports/${reportId}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: data }),
      })
      const j = await res.json()
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`)
      if (insert) onInsert(`![аннотация](${j.url})`)
      onClose()
    } catch (e) {
      setErr('Не удалось сохранить: ' + String((e as Error)?.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="edmodal" onClick={onClose}>
      <div className="edwin" onClick={(e) => e.stopPropagation()}>
        <div className="edtop">
          <span className="edttl">✏ Разметить скриншот</span>
          <span className="edhint">Отредактируйте и вставьте в комментарий</span>
          <button className="edx" onClick={onClose} title="Закрыть · Esc">✕</button>
        </div>

        <div className="edmain">
          <div className="edrail">
            <div className="grp">
              <span className="grpttl">Инструмент</span>
              <div className="tools">
                {TOOLS.map((t) => (
                  <button
                    key={t.key}
                    className={'tb tool' + (tool === t.key ? ' on' : '')}
                    onClick={() => setTool(t.key)}
                    title={`${t.label} · ${t.hot}`}
                    dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-linejoin="round">${t.svg}</svg>` }}
                  />
                ))}
              </div>
              <div className="acts">
                <button className="tb" disabled={!canUndo} onClick={() => annRef.current?.undo()} title="Отменить · Ctrl+Z">↩</button>
                <button className="tb" disabled={!canRedo} onClick={() => annRef.current?.redo()} title="Повторить · Ctrl+Y">↪</button>
                <button className="tb" onClick={() => annRef.current?.clearAll()} title="Очистить · Shift+Del">🗑</button>
              </div>
            </div>

            <div className="grp">
              <span className="grpttl">Цвет</span>
              <div className="cgrid">
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={'cstep' + (c === color ? ' on' : '')}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </div>

            <div className="grp">
              <span className="grpttl">Размер</span>
              <div className="wgrid">
                {(['thin', 'med', 'thick'] as Width[]).map((w) => (
                  <button
                    key={w}
                    className={'wstep' + (w === width ? ' on' : '')}
                    onClick={() => setWidth(w)}
                    title={`${w === 'thin' ? 'Тонкая' : w === 'med' ? 'Средняя' : 'Толстая'} · ${w === 'thin' ? '1' : w === 'med' ? '2' : '3'}`}
                  >
                    <span className={'wdot wdot-' + w} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="edstage" ref={stageRef}>
            <canvas ref={cvRef} className={'edcv edcv-' + tool} />
            {textAt && (
              <div className="tin" style={{ left: textAt.x, top: textAt.y }}>
                <input
                  ref={textInput}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitText() }
                    else if (e.key === 'Escape') { e.preventDefault(); setTextAt(null) }
                  }}
                  onBlur={commitText}
                  placeholder="Текст…"
                />
              </div>
            )}
            {/* Live tool glyph — pinned to the fragment's document with position:fixed via CSS. */}
            <div
              ref={tcurRef}
              className="tcur"
              data-tool={tool}
              dangerouslySetInnerHTML={{
                __html: TOOL_CURSORS[tool as keyof typeof TOOL_CURSORS] ?? '',
              }}
            />
          </div>
        </div>

        <div className="edfoot">
          {err && <span className="ederr">{err}</span>}
          <span className="sep" />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn" onClick={() => save(true)} disabled={busy}>Вставить в комментарий</button>
        </div>
      </div>
    </div>
  )
}
