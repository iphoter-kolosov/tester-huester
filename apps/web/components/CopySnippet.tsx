'use client'
import { useState } from 'react'

// A multi-line command, shown whole and copied whole. Unlike CopyId, a failure here cannot be silent: the text is
// a shell line with a key in it, and «I pressed copy and pasted nothing» is a minute lost to an empty clipboard.
type State = 'idle' | 'done' | 'blocked'

const RESET_MS = 1600
const BLOCKED = 'Буфер обмена недоступен (страница открыта не по https) — выделите команду и скопируйте вручную.'

export default function CopySnippet({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<State>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setState('blocked')
      return
    }
    setState('done')
    setTimeout(() => setState('idle'), RESET_MS)
  }
  return (
    <div className="cnsnip">
      <pre className="cnsnippre">{text}</pre>
      <button type="button" className={'cnsnipbtn' + (state === 'done' ? ' cnsnipbtn-done' : '')} onClick={copy}>
        {state === 'done' ? '✓ Скопировано' : label}
      </button>
      {state === 'blocked' ? <div className="cnsniperr">{BLOCKED}</div> : null}
    </div>
  )
}
