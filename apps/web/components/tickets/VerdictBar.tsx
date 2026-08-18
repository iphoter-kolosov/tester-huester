'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import { ST_REJECTED, ST_VERIFIED } from '@/components/status'
import { patchReport } from './patch'
import s from './controls.module.css'

// Последнее слово по тикету. Принять — один щелчок и больше ничего: по правилам доски владелец и есть
// последняя инстанция. Вернуть — одно поле, потому что сервер не принимает возврат без причины: этот текст
// и есть всё задание на доработку, которое получит исполнитель.
//
// Показывается ТОЛЬКО пока работа сдана и ждёт ответа. В остальное время состояние двигают статусом сбоку:
// пара громких кнопок над тикетом, который никто не сдавал, предлагает закрыть работу, которой не было.

export type VerdictBarProps = {
  id: string
  /** Кому вернётся тикет: исполнитель, который его держит, или адресат. */
  executor: string | null
}

export default function VerdictBar({ id, executor }: VerdictBarProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')
  const [asking, setAsking] = useState<boolean>(false)
  const [reason, setReason] = useState<string>('')

  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    setErr('')
    const out = await patchReport(id, body)
    setBusy(false)
    if (!out.ok) {
      setErr(out.message)
      return false
    }
    router.refresh()
    return true
  }

  const reject = async (): Promise<void> => {
    const comment = reason.trim()
    if (!comment) return
    if (await send({ status: ST_REJECTED, comment })) {
      setReason('')
      setAsking(false)
    }
  }

  return (
    <div className={s.verdict}>
      <div className={s.verdicthead}>
        <span className={s.verdictttl}>⏳ Работа сдана — ждёт вашего слова</span>
        <span className={s.verdictsub}>
          {executor ? `вернётся к ${executor}` : 'исполнитель не назван — вернуть будет некому, кроме как через адресата'}
        </span>
      </div>

      <div className={s.verdictacts}>
        <Button variant="accept" disabled={busy} onClick={() => send({ status: ST_VERIFIED })} title="Принять работу — тикет закрыт">
          ✓ Принять
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => setAsking((v) => !v)} title="Вернуть на доработку с причиной">
          ↩ Вернуть на доработку
        </Button>
      </div>

      {asking ? (
        <div className={s.verdictreason}>
          <textarea
            className={s.verdictta}
            value={reason}
            autoFocus
            placeholder="Что именно не так? Этот текст — всё, что получит исполнитель для доработки."
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                reject()
              }
            }}
          />
          <div className={s.verdictfoot}>
            <span className={s.verdicthint}>⌘/Ctrl+Enter — вернуть</span>
            <Button variant="danger" size="sm" disabled={busy || !reason.trim()} onClick={reject}>
              ↩ Вернуть
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => setAsking(false)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}

      {err ? <div className={s.err}>{err}</div> : null}
    </div>
  )
}
