import type { ReactNode } from 'react'
import Rail from './Rail'
import { shellCounts } from '@/lib/shellCounts'
import type { NavKey } from './nav'
import s from './Shell.module.css'

// Каркас, в котором живут все экраны панели, кроме входа. Экран говорит только, где он находится; цифры
// на рельсе считает каркас — иначе «ждут проверки: 3» на одном экране и «: 5» на другом были бы вопросом
// того, какой экран забыли обновить.
//
// Страницы внутри сохраняют свой .wrap: отступы — их дело, каркас отвечает за рельсу и за то, что
// содержимое занимает всю оставшуюся ширину.

export default function Shell({ active, children }: { active: NavKey; children: ReactNode }) {
  const counts = shellCounts()
  return (
    <div className={s.shell}>
      <Rail active={active} counts={counts} />
      <div className={s.main}>{children}</div>
    </div>
  )
}
