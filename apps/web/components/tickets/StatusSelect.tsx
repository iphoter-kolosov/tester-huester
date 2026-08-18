'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Status } from '@th/db'
import { ST_REJECTED, statusHint, statusOptions } from '@/components/status'
import { cx } from '@/lib/cx'
import { patchReport } from './patch'
import s from './controls.module.css'

// Статус тикета как ОРГАН управления — один на доске и на странице тикета. Читающий вариант (плашка) живёт
// в components/ui/StatusPill: там, где статус только показывают, выпадающий список заставляет читать
// интерфейс вместо работы.
//
// Ключи записаны буквами, а не через константы: `Record<Status, …>` с вычисляемым ключом расширяется до
// индексной сигнатуры и перестаёт ловить забытый статус — а именно ради этого он здесь и стоит.
const TONE: Record<Status, string | undefined> = {
  new: s.st_new,
  taken: s.st_taken,
  needs_review: s.st_needs_review,
  verified: s.st_verified,
  rejected: s.st_rejected,
  wontfix: s.st_wontfix,
}

export type StatusSelectProps = {
  id: string
  status: string
  /** Подпись для скринридера: в плотной строке доски у списка нет видимого заголовка. */
  label?: string
}

export default function StatusSelect({ id, status, label = 'Статус тикета' }: StatusSelectProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')

  const apply = async (next: string): Promise<void> => {
    let body: Record<string, unknown> = { status: next }
    if (next === ST_REJECTED) {
      // Возврат на доработку — единственный переход, который сервер не принимает без причины: этот текст и
      // есть всё задание исполнителю. Спрашиваем здесь, чтобы доска работала одним жестом, а не отскакивала
      // от 400-го ответа.
      const comment = window.prompt('Причина возврата — что именно не так? Этот текст получит исполнитель.')?.trim()
      if (!comment) {
        // Отменили: ничего не записано, поэтому перерисовываемся с сервера — иначе список остался бы
        // показывать статус, который владелец выбрал, но не получил.
        router.refresh()
        return
      }
      body = { status: next, comment }
    }
    setBusy(true)
    setErr('')
    const out = await patchReport(id, body)
    setBusy(false)
    if (out.ok) router.refresh()
    else setErr(out.message)
  }

  const known = (TONE as Record<string, string | undefined>)[status]
  return (
    <>
      <select
        className={cx(s.sel, known ?? s.st_unknown)}
        value={status}
        disabled={busy}
        aria-label={label}
        title={statusHint(status)}
        onChange={(e) => apply(e.target.value)}
      >
        {statusOptions(status).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {err ? <div className={s.err}>{err}</div> : null}
    </>
  )
}
