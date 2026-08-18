import { cx } from '@/lib/cx'
import s from './ui.module.css'

// Цифра рядом с чем-то. Ноль рисуется тише единицы: пустая очередь не должна выглядеть как работа.

export type CountTone = 'neutral' | 'attention' | 'quiet'

export type CountBadgeProps = {
  n: number
  /** `attention` — только «это ждёт вас». Больше ничему этот тон не положен. */
  tone?: CountTone
  title?: string
}

const TONE_CLASS: Record<CountTone, string | undefined> = {
  neutral: '',
  attention: s.count_attention,
  quiet: s.count_quiet,
}

export default function CountBadge({ n, tone = 'neutral', title }: CountBadgeProps) {
  // Ноль всегда тихий, даже когда тон просили громкий: очередь без работы не кричит.
  const cls = cx(s.count, n === 0 ? s.count_zero : TONE_CLASS[tone])
  return (
    <span className={cls} title={title}>
      {n}
    </span>
  )
}
