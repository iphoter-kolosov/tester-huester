import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { repo, buildConnectSnippet, buildInstructions } from '@th/db'
import CopySnippet from '@/components/CopySnippet'
import { isAuthed } from '@/lib/auth'
import { collectorBase } from '@/lib/collector'

export const dynamic = 'force-dynamic'

// Всё, что нужно новому агенту, одним жестом: команда с ключом ИМЕННО этой доски и текст, который агент получит
// в момент подключения. Обе половины собраны из @th/db — той же функцией, что отдаёт их MCP-серверам и
// GET /api/onboarding, — поэтому страница не может показать инструкцию, которой доска больше не следует.
//
// На странице лежит ключ доски. Он не уходит ни в адрес, ни в query, ни в ссылку: только в тело страницы,
// закрытой той же куки, что и остальная панель.

/** Переменные, которые печатает buildConnectSnippet. Названы здесь, потому что текст вокруг команды объясняет
 *  именно их: @th/db владеет строкой, эта страница — объяснением, и разъехаться они не должны молча. */
const ENV_AGENT = 'TH_AGENT'
const ENV_INGEST = 'TH_INGEST_KEY'

export default async function Connect() {
  if (!(await isAuthed())) redirect('/login')

  const projects = repo.listProjects()
  // Состав читается целиком, а не срезом доски: handle — один и тот же агент везде, и агент, читающий текст,
  // должен увидеть коллегу, который просто ещё не работал на этой доске.
  const agents = repo.listAgents()
  const collector = collectorBase(await headers())

  const cards = projects.map((p) => ({
    project: p,
    // Пустой read_key бывает у досок, созданных до ключей. Команду с дырой на месте ключа выдавать нельзя:
    // она выглядит рабочей и падает у агента, а не здесь.
    snippet: p.readKey ? buildConnectSnippet({ collector, readKey: p.readKey }) : null,
    instructions: buildInstructions({
      boardName: p.name,
      // Пока эту страницу читают, никто не подключён — текст говорит «представься», ровно то, что нужно
      // ещё не настроенному агенту.
      identity: { kind: 'unknown' },
      roster: { kind: 'known', agents },
    }),
  }))

  // Сторож против молчаливой лжи: если переменные в команде переименуют, объяснения ниже станут неверными,
  // а страница выглядит исправной. Пусть кричит.
  const drifted = [ENV_AGENT, ENV_INGEST].filter((v) => cards.some((c) => c.snippet && !c.snippet.includes(v)))

  return (
    <main className="wrap">
      <Link className="back" href="/agents">← состав</Link>
      <div className="h" style={{ marginTop: 10 }}>
        <span className="h1">Подключить агента</span>
        <span className="c">досок: {projects.length}</span>
        <Link className="hnav" href="/" title="Все тикеты">На доску</Link>
      </div>
      <p className="rosterlead">
        Одна команда на доску — и агент видит тикеты, состав и ленту событий. Инструкцию в его CLAUDE.md копировать
        не нужно: сервер сам рассказывает правила при подключении, а что именно он скажет — видно ниже, под каждой
        командой.
      </p>

      {drifted.length ? (
        <div className="cnalert">
          Команда больше не содержит {drifted.join(', ')} — переменные переименовали в @th/db, объяснения на этой
          странице устарели. Читайте команду, а не текст вокруг неё.
        </div>
      ) : null}

      <ol className="cnsteps">
        <li>
          Скопируйте команду нужной доски и выполните её <b>в каталоге агента</b> — там, откуда он запускается.
        </li>
        <li>
          В команде замените <code>{ENV_AGENT}</code> на <b>настоящее имя агента</b>. Без него записи подписываются
          именем доски, агента нет в составе и адресовать ему работу нельзя — именно так появляются «имена вне
          состава».
        </li>
        <li>
          <code>{ENV_INGEST}</code> нужен, только если агент будет <b>сам ставить тикеты</b>. Ключ — ниже, в карточке
          доски. Если агент только чинит чужие тикеты, строку можно удалить.
        </li>
        <li>
          Путь в конце команды — папка с копией репозитория <code>tester-huester</code> на машине агента.
        </li>
      </ol>

      <div className="cnnote">
        После добавления или изменения сервера <b>перезапустите приложение агента</b>. MCP-серверы читаются один раз
        при старте: без перезапуска агент работает со старым списком инструментов и сообщает, что их не существует.
      </div>

      {projects.length === 0 ? (
        <div className="empty">
          Ни одной доски. Создайте её на <Link href="/">главной</Link> — ключи выдаются вместе с доской.
        </div>
      ) : null}

      {cards.map(({ project, snippet, instructions }) => (
        <section className="cnproj" key={project.id}>
          <div className="cnhead">
            <span className="cnname">{project.name}</span>
            <span className="cnkeyk">ключ агента в команде</span>
          </div>

          {snippet ? (
            <CopySnippet text={snippet} label="Скопировать команду" />
          ) : (
            <div className="cnkeyless">
              У этой доски нет ключа агента — подключиться к ней нечем. Выдайте ключ на <Link href="/">главной</Link>:
              полоса projects, кнопка ↻ в строке agent.
            </div>
          )}

          {/* Ключ ingest лежит здесь, а не только на главной, чтобы «выдать агенту всё» было одним заходом.
              Он показан рядом с командой, куда его и вписывают, и нужен не всем — поэтому подписан как условный. */}
          <div className="cningest">
            <span className="cningestk">{ENV_INGEST}</span>
            <code>{project.ingestKey}</code>
            <span className="cningesthint">нужен только тому, кто ставит тикеты</span>
          </div>

          <details className="cnwhat" open={projects.length === 1}>
            <summary className="cnwhatsum">Что агент прочитает, подключившись к «{project.name}»</summary>
            <p className="cnwhatlead">
              Этот текст собран из правил, которые доска применяет, и из живого состава — он не может отстать от
              кода. Агент получает его при подключении, отдельно посылать ничего не нужно.
            </p>
            <pre className="cnwhatpre">{instructions}</pre>
          </details>
        </section>
      ))}
    </main>
  )
}
