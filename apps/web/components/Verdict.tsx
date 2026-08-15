'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ST_NEEDS_REVIEW, ST_REJECTED, ST_VERIFIED, statusLabel } from './status'

// The owner's final word on a ticket, as two buttons instead of a form. ACCEPT is one click and costs nothing
// else — he is the last word by rule. RETURN opens a single field, because a rework order with no reason is the
// one thing the API refuses from everybody: that text IS the instruction the executor gets.
export default function Verdict({
  id,
  status,
  assignee,
}: {
  id: string
  status: string
  assignee: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')
  const [asking, setAsking] = useState<boolean>(false)
  const [reason, setReason] = useState<string>('')

  // Every refusal is shown with the server's own wording — it says what is missing and what to do about it.
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

  const reject = async () => {
    const comment = reason.trim()
    if (!comment) return
    if (await patch({ status: ST_REJECTED, comment })) {
      setReason('')
      setAsking(false)
    }
  }

  const saveAssignee = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const next = String(new FormData(e.currentTarget).get('assignee') ?? '').trim()
    await patch({ assignee: next || null })
  }

  const waiting = status === ST_NEEDS_REVIEW
  return (
    <div className={'vd' + (waiting ? ' vd-wait' : '')}>
      <div className="vdhead">
        <span className="vdttl">{waiting ? '⏳ Работа сдана — ждёт вашего слова' : 'Ваше слово'}</span>
        <span className="vdsub">сейчас: {statusLabel(status)}</span>
      </div>

      <div className="vdacts">
        <button
          className="vdbtn vdacc"
          onClick={accept}
          disabled={busy || status === ST_VERIFIED}
          title={status === ST_VERIFIED ? 'Уже принято' : 'Принять работу — тикет закрыт'}
        >
          ✓ Принять
        </button>
        <button
          className="vdbtn vdrej"
          onClick={() => setAsking((v) => !v)}
          disabled={busy}
          title="Вернуть на доработку с причиной"
        >
          ↩ Вернуть на доработку
        </button>

        <form className="vdasg" onSubmit={saveAssignee}>
          <span className="vdasgk">адресовать</span>
          {/* Re-keyed on the stored value so the field follows the server (identities are stored lowercased). */}
          <input
            key={assignee ?? ''}
            name="assignee"
            className="vdasgin"
            defaultValue={assignee ?? ''}
            placeholder="агент или отдел"
            maxLength={64}
            disabled={busy}
          />
          <button className="vdasgbtn" type="submit" disabled={busy}>
            Сохранить
          </button>
        </form>
      </div>

      {asking ? (
        <div className="vdreason">
          <textarea
            className="vdta"
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
          <div className="vdreasonfoot">
            <span className="ednote-hint">⌘/Ctrl+Enter — вернуть</span>
            <button className="vdbtn vdrej" onClick={reject} disabled={busy || !reason.trim()}>
              ↩ Вернуть
            </button>
            <button className="vdcancel" onClick={() => setAsking(false)} disabled={busy}>
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {err ? <div className="vderr">{err}</div> : null}
    </div>
  )
}
