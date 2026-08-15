// The three selections the board offers the owner, as URL values. They mirror the three questions an agent asks
// the journal (inbox / review / rework) but from the owner's seat: he sees everything, so what he needs is a way
// to cut everything down to the part that is waiting for HIM.
export const VIEW_REVIEW = 'review'
export const VIEW_ADDRESSED = 'addressed'
export const VIEW_FILED = 'filed'

export const BOARD_VIEWS = [VIEW_REVIEW, VIEW_ADDRESSED, VIEW_FILED] as const
export type BoardView = (typeof BOARD_VIEWS)[number]

export const VIEW_LABEL: Record<BoardView, string> = {
  [VIEW_REVIEW]: '⏳ Ждут проверки',
  [VIEW_ADDRESSED]: 'Адресовано мне',
  [VIEW_FILED]: 'Поставил я',
}

export const VIEW_HINT: Record<BoardView, string> = {
  [VIEW_REVIEW]: 'Работа сдана и ждёт слова — ваша очередь',
  [VIEW_ADDRESSED]: 'Тикеты, адресованные вам',
  [VIEW_FILED]: 'Тикеты, поставленные вами',
}

export type ViewCounts = Record<BoardView, number>

// Anything else in ?view= is not a view we have — the board shows everything rather than an empty list nobody
// asked for, and the toolbar highlights "Всё" so the address bar and the screen agree.
export function asBoardView(raw: string | undefined): BoardView | '' {
  return (BOARD_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as BoardView) : ''
}
