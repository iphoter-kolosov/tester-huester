'use client'
import { useState } from 'react'
import ShotEditor from './ShotEditor'

// Screenshot + a small "Annotate" launcher in the corner. Clicking opens the ShotEditor modal; the resulting
// image URL is broadcast on a window event that the CommentThread reply box listens for and inserts as a
// markdown image reference — the "look here" round-trip becomes a single modal.
export default function ShotWithEditor({ src, reportId }: { src: string; reportId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="dshotwrap">
      <img className="dshot" src={src} alt="" />
      <button className="dshotedit" onClick={() => setOpen(true)}>✏ Разметить</button>
      {open && (
        <ShotEditor
          imageUrl={src}
          reportId={reportId}
          onClose={() => setOpen(false)}
          onInsert={(md) => {
            // The reply box (CommentThread) listens for this and inserts the markdown at the caret.
            window.dispatchEvent(new CustomEvent('th:insert-comment', { detail: md }))
          }}
        />
      )}
    </div>
  )
}
