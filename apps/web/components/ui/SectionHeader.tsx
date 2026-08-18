import type { ReactNode } from 'react'
import CountBadge, { type CountTone } from './CountBadge'
import { cx } from '@/lib/cx'
import s from './ui.module.css'

// Заголовок куска экрана: что это, сколько там и что с этим можно сделать. Одна форма на все экраны —
// иначе «Ждут проверки» на одном и «ждут проверки» на другом читаются как два разных раздела.

export type SectionHeaderProps = {
  title: ReactNode
  /** Цифра рядом с названием — только там, где счёт что-то значит. */
  count?: number
  countTone?: CountTone
  countTitle?: string
  hint?: ReactNode
  /** Крупный вариант — для заголовка самого экрана, не раздела внутри него. */
  lead?: boolean
  /** Без разделительной линии: когда раздел и так стоит в своей карточке. */
  plain?: boolean
  /** Кнопки и ссылки, прижатые вправо. */
  actions?: ReactNode
}

export default function SectionHeader({
  title,
  count,
  countTone = 'neutral',
  countTitle,
  hint,
  lead = false,
  plain = false,
  actions,
}: SectionHeaderProps) {
  return (
    <div className={cx(s.sec, plain && s.sec_plain)}>
      <h2 className={cx(s.secttl, lead && s.secttl_lg)}>{title}</h2>
      {typeof count === 'number' ? <CountBadge n={count} tone={countTone} title={countTitle} /> : null}
      {hint ? <span className={s.sechint}>{hint}</span> : null}
      {actions ? <span className={s.secacts}>{actions}</span> : null}
    </div>
  )
}
