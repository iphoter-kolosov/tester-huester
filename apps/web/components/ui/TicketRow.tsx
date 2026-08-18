import Link from 'next/link'
import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'
import s from './ui.module.css'

// Строка тикета: снимок слева, суть в середине, органы управления справа. Слоты, а не готовое содержимое —
// экраны показывают разное («Мой ход» — отчёт о работе, «Тикеты» — фильтры и статусы), но геометрия у
// строки одна, иначе список перестаёт читаться колонками.
//
// Снимок — крупнее прежнего (120×78): доказательство и есть содержимое тикета, обвязка обязана уступать.

export type TicketRowProps = {
  /** Куда ведёт вся строка. */
  href: string
  screenshotUrl?: string | null
  /** Заметка тикета — то, что он про что. */
  title: ReactNode
  /** Идентификатор, проект, возраст, адрес страницы. */
  meta?: ReactNode
  /** Кто поставил / кому / кто держит. */
  who?: ReactNode
  /** Всё, что можно сказать о тикете значками: шаги, консоль, вложения, видео. */
  badges?: ReactNode
  /** Правая колонка: статус, передача, архив. */
  aside?: ReactNode
  /** Дополнительный блок во всю ширину строки — например, отчёт о работе на экране «Мой ход». */
  children?: ReactNode
  /** Ждёт слова владельца: полоса цветом внимания. */
  attention?: boolean
  /** В архиве. */
  dimmed?: boolean
}

export default function TicketRow({
  href,
  screenshotUrl,
  title,
  meta,
  who,
  badges,
  aside,
  children,
  attention = false,
  dimmed = false,
}: TicketRowProps) {
  const cls = cx(s.trow, attention && s.trow_attention, dimmed && s.trow_dimmed)
  return (
    <div className={cls}>
      <Link className={s.trowshot} href={href} tabIndex={-1} aria-hidden>
        {screenshotUrl ? (
          <img className={s.trowthumb} src={screenshotUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className={s.trownoshot}>📷</span>
        )}
      </Link>
      <div className={s.trowmid}>
        <Link className={s.trowttl} href={href}>
          {title}
        </Link>
        {meta ? <div className={s.trowmeta}>{meta}</div> : null}
        {who}
        {badges}
        {children}
      </div>
      {aside ? <div className={s.trowaside}>{aside}</div> : null}
    </div>
  )
}
