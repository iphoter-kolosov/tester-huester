'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Edit a report's note text after creation. Saves on ⌘/Ctrl+Enter or the Save button; dirty state is visible.
export default function EditableNote({ id, value }: { id: string; value: string }) {
  const router = useRouter()
  const [text, setText] = useState(value)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const dirty = text !== value

  const save = async () => {
    if (!dirty || busy) return
    setBusy(true)
    setSaved(false)
    try {
      const r = await fetch(`/api/reports/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: text }),
      })
      if (r.ok) {
        setSaved(true)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ednote">
      <textarea
        className="ednote-ta"
        value={text}
        placeholder="Опишите проблему…"
        onChange={(e) => { setText(e.target.value); setSaved(false) }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save() } }}
      />
      <div className="ednote-foot">
        <span className="ednote-hint">{saved ? 'Сохранено ✓' : dirty ? 'Не сохранено · ⌘/Ctrl+Enter' : ''}</span>
        <button className="ednote-save" disabled={!dirty || busy} onClick={save}>Сохранить</button>
      </div>
    </div>
  )
}
