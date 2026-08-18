// Слова доски для того, что не относится к жизненному циклу: тип тикета и важность. Лежат отдельным файлом
// БЕЗ 'use client' намеренно — эти списки читают и серверные экраны (подпись в строке доски), и клиентские
// органы управления, а экспорт из клиентского модуля приходит на сервер подменённым на ссылку и перестаёт
// быть массивом.
//
// Значения обязаны совпадать с тем, что принимает PATCH /api/reports/:id (TYPES и SEVERITIES в маршруте):
// список, предлагающий значение, которое сервер отвергнет, — ловушка.

export type PropOption = { value: string; label: string }

export const TICKET_TYPES: readonly PropOption[] = [
  { value: 'feature', label: 'Фича' },
  { value: 'bug', label: 'Баг' },
  { value: 'fix', label: 'Правка' },
  { value: 'text', label: 'Текст' },
]

export const SEVERITIES: readonly PropOption[] = [
  { value: 'low', label: 'мелочь' },
  { value: 'med', label: 'обычная' },
  { value: 'high', label: 'важная' },
  { value: 'crit', label: 'критичная' },
]

/** Важность, которую сервер подразумевает у тикета без явного значения. */
export const DEFAULT_SEVERITY = 'med'
