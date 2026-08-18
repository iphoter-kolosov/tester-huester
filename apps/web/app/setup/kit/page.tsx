import { redirect } from 'next/navigation'
import { STATUS_ORDER } from '@/components/status'
import Shell from '@/components/shell/Shell'
import AgentChip from '@/components/ui/AgentChip'
import Button from '@/components/ui/Button'
import CountBadge from '@/components/ui/CountBadge'
import EmptyState from '@/components/ui/EmptyState'
import SectionHeader from '@/components/ui/SectionHeader'
import StatusPill from '@/components/ui/StatusPill'
import TicketRow from '@/components/ui/TicketRow'
import { isAuthed } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Набор деталей, из которых собраны экраны. Страница существует ради одного: деталь, которую никто не
// открывал, ломается молча — здесь все они стоят рядом и на одной бумаге, поэтому расхождение видно сразу.

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

export default async function Kit() {
  if (!(await isAuthed())) redirect('/login')
  return (
    <Shell active="setup">
      <main className="wrap">
        <SectionHeader lead title="Набор деталей" hint="Как выглядят общие части интерфейса на этой бумаге" />

        <SectionHeader title="Статусы" hint="жизненный цикл тикета, слева направо" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
          {STATUS_ORDER.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
          <StatusPill status="fixed" />
        </div>

        <SectionHeader title="Агенты" hint="имя, роль и ответ на «отвечал ли он сегодня»" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
          <AgentChip handle="erental" title="Агент eRENTAL" lastSeen={now - 0.02 * DAY} />
          <AgentChip handle="sec-research" title="Агент security-ресёрча" lastSeen={now - 2.5 * DAY} />
          <AgentChip handle="photoking-web" lastSeen={now - 9 * DAY} showRole role="" />
          <AgentChip handle="extension" title="Расширение браузера" retired />
          <AgentChip handle="иван" unknown />
        </div>

        <SectionHeader title="Кнопки" hint="вариант выбирается по смыслу действия" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
          <Button variant="accept">✓ Принять</Button>
          <Button variant="primary">Передать</Button>
          <Button variant="ghost">В архив</Button>
          <Button variant="quiet">Сбросить</Button>
          <Button variant="danger">Удалить</Button>
          <Button variant="ghost" disabled>Недоступно</Button>
          <Button variant="ghost" size="sm">Мелкая</Button>
        </div>

        <SectionHeader title="Счётчики" countTitle="сколько ждёт" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 32 }}>
          <CountBadge n={8} tone="attention" title="ждут вашего слова" />
          <CountBadge n={24} />
          <CountBadge n={4} tone="quiet" />
          <CountBadge n={0} tone="attention" title="очередь пуста" />
        </div>

        <SectionHeader title="Строка тикета" hint="слоты: снимок, суть, мета, адресация, значки, органы управления" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
          <TicketRow
            href="#"
            attention
            title="Цена в списке и цена в корзине расходятся на скидку 18,5 %"
            meta={<><span className="tid">#5e626192</span><span className="proj-tag">eRENTAL</span><span>2 ч</span></>}
            who={<AgentChip handle="erental" title="Агент eRENTAL" lastSeen={now - 0.02 * DAY} plain />}
            badges={<div className="badges"><span className="badge">2 шага</span><span className="badge bad">1 ошибка</span></div>}
            aside={<><StatusPill status="needs_review" /><Button variant="accept" size="sm">✓ Принять</Button></>}
          />
          <TicketRow
            href="#"
            title="Поиск по «canon 24-70» не находит товар, который есть в каталоге"
            meta={<><span className="tid">#ac6f17ff</span><span className="proj-tag">eRENTAL</span><span>1 дн</span></>}
            aside={<StatusPill status="taken" />}
          />
          <TicketRow href="#" dimmed title="Старый тикет в архиве" aside={<StatusPill status="verified" size="sm" />} />
        </div>

        <SectionHeader title="Пусто" hint="пустое место обязано отличаться от сломанного" />
        <EmptyState
          title="Очередь пуста"
          hint="Никто не ждёт вашего слова. Как только агент сдаст работу, тикет появится здесь."
          actions={<Button variant="ghost">Смотреть все тикеты</Button>}
        />
      </main>
    </Shell>
  )
}
