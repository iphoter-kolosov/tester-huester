'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import s from './manager.module.css'

// «Раздать всё уверенное» — те же назначения, что стоят построчно ниже, но одним жестом. Ради этого экран и
// существует: 196 ничьих тикетов не адресуются по одному вручную. Показать ПЕРЕД тем, как сделать, —
// обязательное условие: сначала список «вот что произойдёт», и только по второму подтверждению записи уходят.
//
// Пишет тот же PATCH /api/reports/[id], по одному, последовательно — чтобы каждый отказ был виден отдельной
// строкой, а не растворился в «часть не прошла». Неоднозначное сюда не попадает: список собран из assign с
// высокой уверенностью (см. managerView.confident), а applicable-проверка границы уже пройдена там.

export type BulkItem = {
  id: string
  shortId: string
  agentHandle: string
  agentName: string
  /** Первая строка тикета — чтобы в предпросмотре было видно, что именно уходит, а не только его номер. */
  note: string
}

type ItemState = 'pending' | 'ok' | { error: string }

export default function BulkAssign({ items }: { items: BulkItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState<boolean>(false)
  const [running, setRunning] = useState<boolean>(false)
  const [result, setResult] = useState<Map<string, ItemState>>(new Map())
  const [finished, setFinished] = useState<boolean>(false)

  if (items.length === 0) return null

  const run = async (): Promise<void> => {
    setRunning(true)
    const acc = new Map<string, ItemState>()
    for (const it of items) {
      try {
        const res = await fetch(`/api/reports/${it.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assignee: it.agentHandle }),
        })
        const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
        acc.set(it.id, res.ok ? 'ok' : { error: data?.message || data?.error || `сервер ответил ${res.status}` })
      } catch (e) {
        acc.set(it.id, { error: `запрос не ушёл: ${(e as Error).message}` })
      }
      // Обновляем на каждом шаге: владелец видит, как строки одна за другой становятся зелёными, а не ждёт всё разом.
      setResult(new Map(acc))
    }
    setRunning(false)
    setFinished(true)
    // Успешно розданные тикеты уедут из разделов ниже — перерисовываем доску под уже применённое.
    router.refresh()
  }

  const okCount = [...result.values()].filter((v) => v === 'ok').length
  const failCount = [...result.values()].filter((v) => v !== 'ok' && v !== 'pending').length

  return (
    <div className={s.bulk}>
      {!open ? (
        <Button variant="primary" onClick={() => setOpen(true)} title="Показать, что будет роздано, и подтвердить">
          Раздать всё уверенное ({items.length})
        </Button>
      ) : (
        <div className={s.bulkbox}>
          <p className={s.bulkttl}>
            {finished
              ? `Готово: роздано ${okCount}${failCount ? `, не прошло ${failCount}` : ''}.`
              : `Будет роздано ${items.length} — проверьте, кому что уходит:`}
          </p>
          <ul className={s.bulklist}>
            {items.map((it) => {
              const st = result.get(it.id)
              return (
                <li className={s.bulkrow} key={it.id}>
                  <span className={s.bulktid}>#{it.shortId}</span>
                  <span className={s.bulknote}>{it.note || 'без заметки'}</span>
                  <span className={s.bulkarrow}>→</span>
                  <span className={s.bulkto}>{it.agentName}</span>
                  {st === 'ok' ? (
                    <span className={s.bulkok}>✓</span>
                  ) : st && st !== 'pending' ? (
                    <span className={s.bulkfail} title={st.error}>✗ {st.error}</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {!finished ? (
            <div className={s.bulkfoot}>
              <Button variant="quiet" onClick={() => setOpen(false)} disabled={running}>
                Отмена
              </Button>
              <Button variant="primary" onClick={() => void run()} disabled={running}>
                {running ? 'Раздаю…' : `Раздать ${items.length}`}
              </Button>
            </div>
          ) : (
            <div className={s.bulkfoot}>
              {failCount > 0 ? (
                <span className={s.bulkfailnote}>Что не прошло — осталось в списке ниже, разберите поштучно.</span>
              ) : null}
              <Button variant="quiet" onClick={() => setOpen(false)}>
                Закрыть
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
