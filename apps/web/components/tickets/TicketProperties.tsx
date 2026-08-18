'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DEFAULT_SEVERITY, SEVERITIES, TICKET_TYPES, type PropOption } from './vocab'
import { patchReport } from './patch'
import s from './controls.module.css'

// Тип, важность и проект. На доске их нет намеренно: в строке они добавляли три выпадающих списка к каждому
// тикету и ровно ничего не отвечали на вопрос «что с этим делать» — читать их надо тогда, когда тикет уже
// открыт. Здесь они стоят подписанными, поэтому не нужно гадать, что означает список со словом «med».

export type TicketPropertiesProps = {
  id: string
  type: string
  severity: string | null
  projectId: string
  projects: readonly PropOption[]
}

export default function TicketProperties({ id, type, severity, projectId, projects }: TicketPropertiesProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')

  const apply = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setErr('')
    const out = await patchReport(id, body)
    setBusy(false)
    if (out.ok) router.refresh()
    else setErr(out.message)
  }

  return (
    <div className={s.props}>
      <div className={s.proprow}>
        <span className={s.propk}>Тип</span>
        <select className={s.sel} value={type} disabled={busy} aria-label="Тип тикета" onChange={(e) => apply({ type: e.target.value })}>
          {TICKET_TYPES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className={s.proprow}>
        <span className={s.propk}>Важность</span>
        <select
          className={s.sel}
          value={severity || DEFAULT_SEVERITY}
          disabled={busy}
          aria-label="Важность"
          onChange={(e) => apply({ severity: e.target.value })}
        >
          {SEVERITIES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className={s.proprow}>
        <span className={s.propk}>Проект</span>
        <select
          className={s.sel}
          value={projectId}
          disabled={busy || projects.length < 2}
          aria-label="Проект"
          title={projects.length < 2 ? 'Проект на доске один — переносить некуда' : 'Перенести тикет в другой проект'}
          onChange={(e) => apply({ projectId: e.target.value })}
        >
          {projects.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      {err ? <div className={s.err}>{err}</div> : null}
    </div>
  )
}
