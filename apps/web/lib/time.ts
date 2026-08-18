// Возраст события словами. Три экрана печатают одну и ту же строку — значит формулировка одна, а не три
// похожие: «2 ч» на доске и «2 часа назад» в составе про одно и то же читаются как разные факты.

const MINUTE = 60_000

/** Короткая форма для плотных строк: «сейчас», «12 мин», «3 ч», «5 дн». */
export function ago(ms: number, now: number = Date.now()): string {
  const mins = Math.floor((now - ms) / MINUTE)
  if (mins < 1) return 'сейчас'
  if (mins < 60) return `${mins} мин`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} дн`
}

/** Полная форма для карточек и подписей: «только что», «12 мин назад», «3 ч назад», «5 дн назад». */
export function agoLong(ms: number, now: number = Date.now()): string {
  const mins = Math.floor((now - ms) / MINUTE)
  if (mins < 1) return 'только что'
  return `${ago(ms, now)} назад`
}

/** Точное время для подсказки — то, что человек читает, когда относительное «5 дн» его не устраивает. */
export function exact(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU')
}
