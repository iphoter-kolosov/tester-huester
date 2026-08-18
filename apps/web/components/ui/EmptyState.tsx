import type { ReactNode } from 'react'
import s from './ui.module.css'

// Пусто — это тоже ответ, и он обязан отличаться от «сломалось». Поэтому у пустого места есть заголовок
// («очередь пуста») и подсказка, что это значит, а не одна серая строчка посреди экрана.

export type EmptyStateProps = {
  title: ReactNode
  hint?: ReactNode
  /** Кнопка, которая имеет смысл именно здесь: поставить тикет, снять фильтр, позвать агента. */
  actions?: ReactNode
}

export default function EmptyState({ title, hint, actions }: EmptyStateProps) {
  return (
    <div className={s.empty}>
      <p className={s.emptyttl}>{title}</p>
      {hint ? <p className={s.emptyhint}>{hint}</p> : null}
      {actions ? <div className={s.emptyacts}>{actions}</div> : null}
    </div>
  )
}
