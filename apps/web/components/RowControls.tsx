'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Opt = { value: string; label: string }

const TYPES: Opt[] = [
  { value: 'feature', label: 'Фича' },
  { value: 'bug', label: 'Баг' },
  { value: 'fix', label: 'Правка' },
  { value: 'text', label: 'Текст' },
]
const SEVS: Opt[] = [
  { value: 'low', label: 'low' },
  { value: 'med', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'crit', label: 'crit' },
]
const STATUSES: Opt[] = [
  { value: 'new', label: 'new' },
  { value: 'triaged', label: 'triaged' },
  { value: 'fixed', label: 'fixed' },
  { value: 'wontfix', label: 'wontfix' },
]

// Full post-creation editing for one report: type / severity / status / project selects + archive→delete.
// Every change PATCHes the report and refreshes; delete is DELETE and only offered once archived.
export default function RowControls({
  id,
  type,
  severity,
  status,
  projectId,
  projects,
  archived,
}: {
  id: string
  type: string
  severity: string | null
  status: string
  projectId: string
  projects: Opt[]
  archived: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const r = await fetch(`/api/reports/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }
  const del = async () => {
    if (!confirm('Удалить тикет безвозвратно?')) return
    setBusy(true)
    try {
      const r = await fetch(`/api/reports/${id}`, { method: 'DELETE' })
      if (r.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rowctl">
      <div className="rowctl-selects">
        <select className={'ec ec-tp tp-' + type} value={type} disabled={busy} onChange={(e) => patch({ type: e.target.value })} title="Тип">
          {TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className={'ec ec-sv sv-' + (severity || 'med')} value={severity || 'med'} disabled={busy} onChange={(e) => patch({ severity: e.target.value })} title="Важность">
          {SEVS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className={'ec ec-st st-' + status} value={status} disabled={busy} onChange={(e) => patch({ status: e.target.value })} title="Статус">
          {STATUSES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="ec ec-pr" value={projectId} disabled={busy || projects.length < 2} onChange={(e) => patch({ projectId: e.target.value })} title="Проект">
          {projects.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="rowctl-acts">
        {archived ? (
          <>
            <button className="ea" disabled={busy} onClick={() => patch({ archived: false })} title="Вернуть из архива">↩ Восстановить</button>
            <button className="ea ea-del" disabled={busy} onClick={del} title="Удалить безвозвратно">🗑 Удалить</button>
          </>
        ) : (
          <button className="ea" disabled={busy} onClick={() => patch({ archived: true })} title="В архив">🗄 В архив</button>
        )}
      </div>
    </div>
  )
}
