'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import { ST_REJECTED, ST_VERIFIED } from '@/components/status'
import s from './mine.module.css'

// Слово владельца прямо в строке очереди — ради этого экран и существует: принять или вернуть, не открывая
// тикет. Открывать приходится ровно тогда, когда отчёта о работе не хватило, — и тогда ссылка рядом.
//
// Пишет тот же PATCH /api/reports/[id], что и карточка тикета: там лежит вся проверка перехода (кто имеет
// право принимать, что обязано быть приложено). Своя, «быстрая» запись мимо него означала бы вторую копию
// жизненного цикла, которая разойдётся с первой на первой же правке правил.

export type RowVerdictProps = {
  id: string
  /** Как тикет называют вслух — попадает в подсказку, чтобы кнопка не была безымянной в очереди из десяти строк. */
  shortId: string
}

export default function RowVerdict({ id, shortId }: RowVerdictProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')
  const [asking, setAsking] = useState<boolean>(false)
  const [reason, setReason] = useState<string>('')

  // Отказ показывается словами сервера: он называет, чего не хватает и что с этим делать.
  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
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
        return false
      }
      router.refresh()
      return true
    } catch (e) {
      setErr(`Запрос не ушёл: ${(e as Error).message}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const accept = () => patch({ status: ST_VERIFIED })

  // Возврат без причины сервер отвергает — и правильно делает: этот текст И ЕСТЬ всё задание на доработку.
  // Поэтому причину спрашиваем здесь, а не даём владельцу упереться в 400.
  const reject = async (): Promise<void> => {
    const comment = reason.trim()
    if (!comment) return
    if (await patch({ status: ST_REJECTED, comment })) {
      setReason('')
      setAsking(false)
    }
  }

  return (
    <div className={s.verdict}>
      <div className={s.verdictacts}>
        <Button
          variant="accept"
          size="sm"
          onClick={accept}
          disabled={busy}
          title={`Принять работу по тикету ${shortId} — он закрыт`}
        >
          ✓ Принять
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAsking((v) => !v)}
          disabled={busy}
          title="Вернуть на доработку — понадобится причина"
          aria-expanded={asking}
        >
          ↩ Вернуть
        </Button>
      </div>

      {asking ? (
        <div className={s.reason}>
          <textarea
            className={s.reasonta}
            value={reason}
            autoFocus
            rows={3}
            placeholder="Что именно не так? Этот текст — всё, что получит исполнитель для доработки."
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void reject()
              }
            }}
          />
          <div className={s.reasonfoot}>
            <span className={s.reasonhint}>⌘/Ctrl+Enter — вернуть</span>
            <Button variant="quiet" size="sm" onClick={() => setAsking(false)} disabled={busy}>
              Отмена
            </Button>
            <Button variant="danger" size="sm" onClick={() => void reject()} disabled={busy || !reason.trim()}>
              ↩ Вернуть на доработку
            </Button>
          </div>
        </div>
      ) : null}

      {err ? <p className={s.verdicterr}>{err}</p> : null}
    </div>
  )
}
