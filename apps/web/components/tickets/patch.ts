// Одна дорога для всех правок тикета с панели. Существует ради отказов: сервер отвечает не кодом, а текстом,
// который называет, ЧЕГО не хватает и что с этим делать (например, отказ по адресату прикладывает список тех,
// кому передать можно). Пересказывать это своими словами — значит терять список; поэтому сообщение сервера
// показывается дословно, а собственная формулировка остаётся только там, где ответа не было вовсе.

export type PatchOutcome = { ok: true } | { ok: false; message: string }

type ApiError = { message?: string; error?: string }

async function call(id: string, init: RequestInit): Promise<PatchOutcome> {
  try {
    const res = await fetch(`/api/reports/${id}`, init)
    const data = (await res.json().catch(() => null)) as ApiError | null
    if (!res.ok) {
      return { ok: false, message: data?.message || data?.error || `Сервер ответил ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `Запрос не ушёл: ${(e as Error).message}` }
  }
}

export function patchReport(id: string, body: Record<string, unknown>): Promise<PatchOutcome> {
  return call(id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Удаление разрешено только после архива — сервер отвечает 409 archive_first, и это тоже видно дословно. */
export function deleteReport(id: string): Promise<PatchOutcome> {
  return call(id, { method: 'DELETE' })
}
