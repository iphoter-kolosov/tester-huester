import type { Status } from '@th/db'
import { statusHint, statusLabel } from '@/components/status'
import { cx } from '@/lib/cx'
import s from './ui.module.css'

// Статус тикета как надпись, а не как выпадающий список. Список — это орган управления, и на экране, где
// нужно только ПРОЧИТАТЬ состояние, он заставляет читать интерфейс вместо работы.
//
// `Record<Status, …>` держит файл честным: добавили статус в ядро — здесь перестанет собираться, а не
// молча покрасится в никакой.

const PILL_CLASS: Record<Status, string | undefined> = {
  new: s.pill_new,
  taken: s.pill_taken,
  needs_review: s.pill_needs_review,
  verified: s.pill_verified,
  rejected: s.pill_rejected,
  wontfix: s.pill_wontfix,
}

export type StatusPillProps = {
  /** Может прийти легаси-строка от старого клиента — она покажется собой, а не ближайшим знакомым статусом. */
  status: string
  size?: 'sm' | 'md'
  title?: string
}

export default function StatusPill({ status, size = 'md', title }: StatusPillProps) {
  const known = (PILL_CLASS as Record<string, string | undefined>)[status]
  const cls = cx(s.pill, size === 'sm' && s.pill_sm, known ?? s.pill_unknown)
  return (
    <span className={cls} title={title ?? statusHint(status)}>
      {statusLabel(status)}
    </span>
  )
}
