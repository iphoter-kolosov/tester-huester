'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Opt = { id: string; name: string }

// Human-only control on the dashboard: reassign a report to a project bucket. Moving exactly the cases an
// agent needs into its project is how you scope what that agent's read key exposes.
export default function ProjectSelect({ id, value, projects }: { id: string; value: string; projects: Opt[] }) {
  const [v, setV] = useState(value)
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  return (
    <select
      className="pmove"
      value={v}
      disabled={busy}
      title="Move this case to a project — an agent with that project's key sees it"
      onChange={async (e) => {
        const nv = e.target.value
        const prev = v
        setBusy(true)
        setV(nv)
        try {
          const res = await fetch(`/api/reports/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: nv }),
          })
          if (!res.ok) setV(prev)
          else router.refresh()
        } catch {
          setV(prev)
        } finally {
          setBusy(false)
        }
      }}
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  )
}
