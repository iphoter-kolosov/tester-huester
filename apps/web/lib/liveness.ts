// Жив ли агент — один ответ на всю панель.
//
// Раньше это знание существовало только внутри /agents, и «кто возьмёт тикет» приходилось выяснять на другой
// странице, чем та, где лежит работа. Пороги вынесены сюда, чтобы рельса, состав и любой экран говорили об
// одном агенте одно и то же: разойтись они могут только вместе.

/** Сутки тишины между сессиями — обычное дело. */
export const QUIET_AFTER_MS = 24 * 60 * 60 * 1000
/** Неделя — точка, где «наверное, ещё работает» перестаёт быть разумным допущением. */
export const SILENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type Liveness = 'live' | 'quiet' | 'silent'

export function liveness(lastSeen: number, now: number = Date.now()): Liveness {
  const idle = now - lastSeen
  if (idle >= SILENT_AFTER_MS) return 'silent'
  if (idle >= QUIET_AFTER_MS) return 'quiet'
  return 'live'
}

export const LIVENESS_LABEL: Record<Liveness, string> = {
  live: 'на связи',
  quiet: 'тихо',
  silent: 'молчит',
}

export const LIVENESS_HINT: Record<Liveness, string> = {
  live: 'Отвечал в последние сутки — этому можно передавать работу',
  quiet: 'Больше суток не выходил на связь',
  silent: 'Больше недели молчит — считать, что работа у него идёт, нельзя',
}
