'use client'
import { useState } from 'react'
import ShotEditor from './ShotEditor'

// Screenshot + a small "Annotate" launcher in the corner. Clicking opens the ShotEditor modal; the resulting
// image URL is broadcast on a window event that the CommentThread reply box listens for and inserts as a
// markdown image reference — the "look here" round-trip becomes a single modal.
// `linkFullSize` wraps the image in a plain link to the original file — used by the attachment gallery, where a
// shot is displayed small and the reader needs the full-resolution pixels one click away. Off by default so the
// ticket's main screenshot keeps behaving exactly as it did.
export default function ShotWithEditor({ src, reportId, linkFullSize = false }: { src: string; reportId: string; linkFullSize?: boolean }) {
  const [open, setOpen] = useState(false)
  const img = <img className="dshot" src={src} alt="" />
  return (
    <div className="dshotwrap">
      {linkFullSize ? <a href={src} target="_blank" rel="noreferrer" title="Открыть в полный размер">{img}</a> : img}
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
