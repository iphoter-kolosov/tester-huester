'use client'
import { useState } from 'react'
import Button from '@/components/ui/Button'
import s from './manager.module.css'

// «Подтолкнуть» — это ПОМЕТКА, а не побудка. Кнопка лишь пишет комментарий в тикет: тот, кто держит работу
// (или кому её принимать), увидит напоминание на своём следующем заходе. Разбудить сессию со стороны экрана
// нельзя намеренно — это ход этапа диспетчеризации, и он под гейтом. Здесь менеджер тороплит словом, не действием.

/** Взято и не двигается — торопим держателя; сдано и ждёт приёмки — напоминаем принять или вернуть. */
export type NudgeKind = 'taken' | 'review'

const NUDGE_TEXT: Record<NudgeKind, string> = {
  taken: 'Напоминание: тикет взят давно и не двигался. Ещё в работе — или вернуть его на доску?',
  review: 'Напоминание: работа сдана и ждёт приёмки. Нужно принять или вернуть с причиной.',
}

export type NudgeButtonProps = {
  id: string
  shortId: string
  kind: NudgeKind
}

export default function NudgeButton({ id, shortId, kind }: NudgeButtonProps) {
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')
  const [done, setDone] = useState<boolean>(false)

  const nudge = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/reports/${id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: NUDGE_TEXT[kind] }),
      })
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
      if (!res.ok) {
        setErr(data?.message || data?.error || `Сервер ответил ${res.status}`)
        return
      }
      // Пометка встала в тикет; тикет не меняет статус, поэтому строка остаётся — говорим прямо, что напомнили.
      setDone(true)
    } catch (e) {
      setErr(`Запрос не ушёл: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (done && !err) return <span className={s.applied}>✓ напоминание оставлено</span>

  return (
    <span className={s.confirm}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void nudge()}
        disabled={busy}
        title={`Оставить напоминание в тикете ${shortId} — пометка в обсуждении, сессию это не будит`}
      >
        Подтолкнуть
      </Button>
      {err ? <span className={s.rowerr}>{err}</span> : null}
    </span>
  )
}
