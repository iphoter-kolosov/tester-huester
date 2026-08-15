import type { Status } from '@th/db'

// The dashboard's words for the lifecycle. The statuses themselves are decided in @th/db; only their Russian
// labels and colours live here — Filters, RowControls and Verdict run in the browser, and a value import from
// @th/db would drag node:sqlite into the client bundle. The `Record<Status, …>` typing is what keeps this file
// honest: rename or add a status in the core and this file stops compiling instead of quietly showing a blank.
// For the same reason the constants below are annotated `: Status` — a value the core no longer knows fails the
// build here.

export const ST_NEW: Status = 'new'
export const ST_TAKEN: Status = 'taken'
export const ST_NEEDS_REVIEW: Status = 'needs_review'
export const ST_VERIFIED: Status = 'verified'
export const ST_REJECTED: Status = 'rejected'
export const ST_WONTFIX: Status = 'wontfix'

// Lifecycle order, so a status list reads like the path a ticket actually walks.
export const STATUS_ORDER: readonly Status[] = [ST_NEW, ST_TAKEN, ST_NEEDS_REVIEW, ST_VERIFIED, ST_REJECTED, ST_WONTFIX]

export const STATUS_LABEL: Record<Status, string> = {
  new: 'новый',
  taken: 'в работе',
  needs_review: 'на проверку',
  verified: 'принято',
  rejected: 'на доработку',
  wontfix: 'не делаем',
}

// What the state means for whoever is looking at the board — the control's tooltip.
export const STATUS_HINT: Record<Status, string> = {
  new: 'Заявлен, никто не взял',
  taken: 'Агент взял в работу',
  needs_review: 'Работа сдана — ждёт вашего слова или слова агента-заказчика',
  verified: 'Проверено и принято',
  rejected: 'Возвращён на доработку с причиной',
  wontfix: 'Отклонён с объяснением',
}

// Rows written before this lifecycle, or by a client we do not know about, are shown under their raw name rather
// than under a guess: an unfamiliar status must look unfamiliar.
export function statusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string | undefined>)[status] ?? status
}

export function statusHint(status: string): string {
  return (STATUS_HINT as Record<string, string | undefined>)[status] ?? `Незнакомый статус «${status}»`
}

export type StatusOption = { value: string; label: string }

// The choices offered for a ticket that currently sits in `status`. If that status is not one of ours it is
// appended, so the control shows the truth instead of silently snapping the ticket to the first option.
export function statusOptions(status: string): StatusOption[] {
  const known = STATUS_ORDER.map((s) => ({ value: s as string, label: STATUS_LABEL[s] }))
  return known.some((o) => o.value === status) || !status ? known : [...known, { value: status, label: status }]
}
