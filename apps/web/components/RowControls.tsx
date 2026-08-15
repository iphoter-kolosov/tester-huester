'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ST_REJECTED, statusHint, statusOptions } from './status'

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
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')

  // A refused change is shown in the server's own words: it names what is missing and what to do about it.
  const patch = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/reports/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
      if (!res.ok) {
        setErr(data?.message || data?.error || `Сервер ответил ${res.status}`)
        return
      }
      router.refresh()
    } catch (e) {
      setErr(`Запрос не ушёл: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // Sending a ticket back is the one status the API refuses from everybody without a reason — ask for it here, so
  // the board keeps working in one gesture instead of bouncing off a 400.
  const changeStatus = (next: string): Promise<void> => {
    if (next !== ST_REJECTED) return patch({ status: next })
    const comment = window.prompt('Причина возврата — что именно не так?')?.trim()
    // Cancelled: nothing is written, so re-render from the server — otherwise the select keeps showing the status
    // the owner picked and never got, which is the one thing a status control must never do.
    if (!comment) {
      router.refresh()
      return Promise.resolve()
    }
    return patch({ status: next, comment })
  }

  const del = async () => {
    if (!confirm('Удалить тикет безвозвратно?')) return
    setBusy(true)
    setErr('')
    try {
      const r = await fetch(`/api/reports/${id}`, { method: 'DELETE' })
      if (r.ok) router.refresh()
      else setErr(`Удалить не вышло: сервер ответил ${r.status}`)
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
        <select className={'ec ec-st st-' + status} value={status} disabled={busy} onChange={(e) => changeStatus(e.target.value)} title={statusHint(status)}>
          {statusOptions(status).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
      {err ? <div className="rowctl-err">{err}</div> : null}
    </div>
  )
}
