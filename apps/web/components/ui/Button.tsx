import type { ButtonHTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import s from './ui.module.css'

// Кнопка панели. Вариант выбирается по СМЫСЛУ действия, а не по вкусу: `accept` — приёмка работы,
// `danger` — то, что трудно откатить. Один экран не должен показывать две одинаково громкие кнопки.
//
// Файл намеренно без 'use client': кнопка одинаково нужна и на сервере (ссылка-действие внутри формы),
// и внутри клиентских компонентов, которые вешают onClick.

export type ButtonVariant = 'primary' | 'accept' | 'ghost' | 'quiet' | 'danger'

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: s.btn_primary,
  accept: s.btn_accept,
  ghost: s.btn_ghost,
  quiet: s.btn_quiet,
  danger: s.btn_danger,
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

export default function Button({ variant = 'ghost', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  const cls = cx(s.btn, VARIANT_CLASS[variant], size === 'sm' && s.btn_sm, className)
  return <button type={type} className={cls} {...rest} />
}
