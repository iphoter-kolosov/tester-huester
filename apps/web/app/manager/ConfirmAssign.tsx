'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import s from './manager.module.css'

// Один клик = адресовано. Пишет тот же PATCH /api/reports/[id], что и карточка тикета: там лежит проверка
// (есть ли такой агент в составе, вправе ли передавать). Своей, «быстрой» записи мимо него не заводим —
// вторая копия правил разошлась бы с первой на первой же правке. Это ПРИМЕНЕНИЕ предложения, а не решение:
// назначить исполнителя — ход, который менеджер вправе сделать (assign в границе дозволенного).

export type ConfirmAssignProps = {
  id: string
  shortId: string
  /** Кому передаём — canonical handle из состава, тот же, что предложил менеджер. */
  agentHandle: string
  /** Как его зовут вслух — в подсказку, чтобы кнопка не была безымянной в списке из двадцати строк. */
  agentName: string
}

export default function ConfirmAssign({ id, shortId, agentHandle, agentName }: ConfirmAssignProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')
  const [done, setDone] = useState<boolean>(false)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`/api/reports/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignee: agentHandle }),
      })
      // Отказ показывается словами сервера — он называет, что не так (нет такого агента, роль не описана) и что делать.
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
      if (!res.ok) {
        setErr(data?.message || data?.error || `Сервер ответил ${res.status}`)
        return
      }
      // Строка исчезнет после refresh (тикет больше не «никто не взял»); краткое «готово» на время перерисовки.
      setDone(true)
      router.refresh()
    } catch (e) {
      setErr(`Запрос не ушёл: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (done && !err) return <span className={s.applied}>✓ передано {agentName}</span>

  return (
    <span className={s.confirm}>
      <Button
        variant="primary"
        size="sm"
        onClick={() => void confirm()}
        disabled={busy}
        title={`Передать тикет ${shortId} исполнителю ${agentName} (${agentHandle})`}
      >
        ПОДТВЕРДИТЬ
      </Button>
      {err ? <span className={s.rowerr}>{err}</span> : null}
    </span>
  )
}
