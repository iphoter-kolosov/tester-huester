// Склейка классов. Существует ровно потому, что в проекте включён noUncheckedIndexedAccess: имя класса из
// CSS-модуля имеет тип `string | undefined`, и `.filter(Boolean)` этого для TypeScript не доказывает.
// Здесь доказательство одно на всех — вместо приведения типа в каждом компоненте.

export type ClassValue = string | false | null | undefined

export function cx(...parts: ClassValue[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}
