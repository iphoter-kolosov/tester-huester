'use client'
import { useState } from 'react'

const OPTS = ['new', 'triaged', 'fixed', 'wontfix']

export default function StatusSelect({ id, value }: { id: string; value: string }) {
  const [v, setV] = useState(value)
  const [busy, setBusy] = useState(false)
  return (
    <select
      className={'st st-' + v}
      value={v}
      disabled={busy}
      onChange={async (e) => {
        const nv = e.target.value
        setBusy(true)
        setV(nv)
        try {
          await fetch(`/api/reports/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: nv }),
          })
        } finally {
          setBusy(false)
        }
      }}
    >
      {OPTS.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  )
}
