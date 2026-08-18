'use client'
import { useState, type ReactNode } from 'react'
import Button from '@/components/ui/Button'
import { cx } from '@/lib/cx'
import s from '@/app/setup/setup.module.css'

// Ключ доски: учётные данные, а не справочная строка. По умолчанию закрыт — раньше оба ключа стояли
// открытым текстом поперёк рабочего экрана, то есть попадали в каждый скриншот и в каждую демонстрацию.
//
// Честно про границу: маска — защита от чужого взгляда и от кадра, а не от чтения исходника страницы.
// Значение приезжает в браузер целиком (иначе «копировать» пришлось бы делать отдельным запросом), и
// страница закрыта той же кукой, что и вся панель.

/** Сколько символов начала остаётся видно: по ним ключ узнаётся, но им не пользуются. */
const VISIBLE_PREFIX = 6
/** Точек вместо хвоста — фиксировано, чтобы маска не выдавала длину ключа. */
const MASK_DOTS = 18

const COPY_BLOCKED =
  'Буфер обмена недоступен (страница открыта не по https) — нажмите «Показать» и скопируйте вручную.'
const COPY_RESET_MS = 1600

type CopyState = 'idle' | 'done' | 'blocked'

export type KeyFieldProps = {
  /** Как ключ называется в разговоре: «ключ агента», «ключ расширения». */
  label: string
  value: string
  /** Зачем он и куда его вписывают — то, ради чего сюда вообще заходят. */
  hint: ReactNode
  /** Форма смены ключа или объяснение, почему сменить нельзя. */
  children?: ReactNode
}

export default function KeyField({ label, value, hint, children }: KeyFieldProps) {
  const [shown, setShown] = useState<boolean>(false)
  const [copy, setCopy] = useState<CopyState>('idle')

  const masked = value.slice(0, VISIBLE_PREFIX) + '•'.repeat(MASK_DOTS)

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Молчаливый провал здесь стоит минуты у чужого агента: он вставит пустоту и получит отказ доски.
      setCopy('blocked')
      return
    }
    setCopy('done')
    setTimeout(() => setCopy('idle'), COPY_RESET_MS)
  }

  return (
    <div className={s.key}>
      <span className={s.keyk}>{label}</span>
      <span className={s.keyline}>
        <code className={cx(s.keyv, !shown && s.keyv_masked)}>{shown ? value : masked}</code>
        <Button variant="ghost" size="sm" onClick={() => setShown(!shown)}>
          {shown ? 'Скрыть' : 'Показать'}
        </Button>
        <Button variant={copy === 'done' ? 'accept' : 'ghost'} size="sm" onClick={onCopy}>
          {copy === 'done' ? '✓ Скопирован' : 'Копировать'}
        </Button>
      </span>
      <p className={s.keyhint}>{hint}</p>
      {copy === 'blocked' ? <p className={s.keyerr}>{COPY_BLOCKED}</p> : null}
      {children}
    </div>
  )
}
