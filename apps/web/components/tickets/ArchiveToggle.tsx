'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import { deleteReport, patchReport } from './patch'
import s from './controls.module.css'

// Архив и удаление — две ступени одной лестницы: с доски тикет только убирается, уничтожается он уже из
// архива (сервер отвечает 409 archive_first на любую попытку срезать угол).
//
// `compact` — вид для строки доски: одна иконка, без удаления. Удаление необратимо, и место ему там, где
// перед глазами весь тикет, а не в списке из шестидесяти строк, где рука промахивается.

export type ArchiveToggleProps = {
  id: string
  archived: boolean
  compact?: boolean
}

export default function ArchiveToggle({ id, archived, compact = false }: ArchiveToggleProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')

  const run = async (fn: () => Promise<{ ok: true } | { ok: false; message: string }>): Promise<void> => {
    setBusy(true)
    setErr('')
    const out = await fn()
    setBusy(false)
    if (out.ok) router.refresh()
    else setErr(out.message)
  }

  const toggle = () => run(() => patchReport(id, { archived: !archived }))

  const destroy = () => {
    if (!window.confirm('Удалить тикет безвозвратно? Вернуть его будет нечем.')) return
    return run(() => deleteReport(id))
  }

  if (compact) {
    return (
      <>
        <Button
          size="sm"
          variant="quiet"
          disabled={busy}
          onClick={toggle}
          title={archived ? 'Вернуть из архива на доску' : 'Убрать с доски в архив'}
          aria-label={archived ? 'Вернуть из архива' : 'В архив'}
        >
          {archived ? '↩' : '🗄'}
        </Button>
        {err ? <div className={s.err}>{err}</div> : null}
      </>
    )
  }

  return (
    <>
      <div className={s.propacts}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={toggle}>
          {archived ? '↩ Вернуть из архива' : '🗄 В архив'}
        </Button>
        {archived ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={destroy}>
            🗑 Удалить
          </Button>
        ) : null}
      </div>
      {err ? <div className={s.err}>{err}</div> : null}
    </>
  )
}
