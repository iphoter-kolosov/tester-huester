'use client'
import { useState } from 'react'

// The ticket handle, click-to-copy. It exists to be pasted into a message to the agent, so making the user
// select 8 characters by hand is friction for the single most repeated action on the board.
export default function CopyId({ id, big }: { id: string; big?: boolean }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      return // clipboard blocked (insecure context) — leave the text selectable instead of faking success
    }
    setDone(true)
    setTimeout(() => setDone(false), 1200)
  }
  return (
    <button
      type="button"
      className={(big ? 'tidbig' : 'tid') + ' tidcopy' + (done ? ' copied' : '')}
      onClick={copy}
      title={done ? 'Скопировано' : 'Нажмите, чтобы скопировать идентификатор'}
    >
      #{id}
      <span className="tidmark">{done ? '✓' : '⧉'}</span>
    </button>
  )
}
