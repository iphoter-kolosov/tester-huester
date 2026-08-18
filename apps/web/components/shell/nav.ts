// Куда вообще можно попасть из панели. Список закрытый: если пункта нет здесь — его нет и в рельсе, и
// экран, который добавит себе ссылку мимо этого файла, окажется местом, откуда не видно, где ты находишься.

export const ROUTE_MINE = '/'
export const ROUTE_TICKETS = '/tickets'
export const ROUTE_AGENTS = '/agents'
export const ROUTE_SETUP = '/setup'
export const ROUTE_CONNECT = '/agents/connect'

export type NavKey = 'mine' | 'tickets' | 'agents' | 'setup'

export type NavItem = {
  key: NavKey
  href: string
  label: string
  hint: string
  /** Какой цифрой подписан пункт. `attention` — единственный тон «это ждёт тебя». */
  countTone: 'attention' | 'neutral' | 'none'
}

export const NAV: readonly NavItem[] = [
  { key: 'mine', href: ROUTE_MINE, label: 'Мой ход', hint: 'Что ждёт вашего слова прямо сейчас', countTone: 'attention' },
  { key: 'tickets', href: ROUTE_TICKETS, label: 'Тикеты', hint: 'Вся доска: фильтры, архив, поиск по работе', countTone: 'neutral' },
  { key: 'agents', href: ROUTE_AGENTS, label: 'Агенты', hint: 'Кто работает доску и кто на связи', countTone: 'neutral' },
]

// Настройка живёт отдельно и внизу: ключи и проекты нужны примерно дважды в месяц, а места на главном
// экране занимали столько, что первый тикет начинался ниже середины первого экрана.
export const SETUP: NavItem = {
  key: 'setup',
  href: ROUTE_SETUP,
  label: 'Настройка',
  hint: 'Проекты, ключи, подключение агента',
  countTone: 'none',
}
