import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { repo, type Report } from '@th/db'
import KeyField from '@/components/KeyField'
import Shell from '@/components/shell/Shell'
import { ROUTE_CONNECT, ROUTE_SETUP, ROUTE_TICKETS } from '@/components/shell/nav'
import Button from '@/components/ui/Button'
import EmptyState from '@/components/ui/EmptyState'
import SectionHeader from '@/components/ui/SectionHeader'
import { isAuthed } from '@/lib/auth'
import { exact } from '@/lib/time'
import s from './setup.module.css'

export const dynamic = 'force-dynamic'

// Настройка доски: проекты и их ключи. Раньше это стояло первым блоком рабочего экрана и отжимало первый
// тикет на 154 px вниз — при том что ключ нужен раз в две недели, а тикеты каждый день. Здесь оно и живёт.
//
// Ключи здесь закрыты по умолчанию (см. KeyField): это учётные данные, и место, куда за ними ходят раз в
// месяц, — не то же самое, что место, которое открыто весь день и попадает в каждый скриншот.

// repo.listReports отказывается отдавать больше этого — потолок назван, чтобы «столько и есть» не путалось
// с «здесь запрос кончился».
const TICKET_CEILING = 1000

// Имена переменных окружения, куда ключи вписывают. Печатаются на экране, потому что вопрос «какой из двух
// куда» — единственный, ради которого сюда заходят второй раз.
const ENV_AGENT_KEY = 'TH_PROJECT_KEY'
const ENV_INGEST_KEY = 'TH_INGEST_KEY'

const MAX_PROJECT_NAME = 40

// Витрина примитивов. Не в nav.ts: это дверь для того, кто правит панель, а не раздел для того, кто ей работает.
const ROUTE_KIT = '/setup/kit'

async function createProject(formData: FormData) {
  'use server'
  if (!(await isAuthed())) return
  const name = String(formData.get('name') || '').trim()
  if (name) repo.createProject(name)
  revalidatePath(ROUTE_SETUP)
}

// Смена ключа чтения: старый умирает мгновенно — ровно то, что нужно, когда ключ утёк, и ровно то, что
// ломает работающего агента, если нажать случайно. Поэтому кнопка живёт под раскрывашкой.
async function regenerateKey(formData: FormData) {
  'use server'
  if (!(await isAuthed())) return
  const id = String(formData.get('projectId') || '')
  if (id) repo.regenerateReadKey(id)
  revalidatePath(ROUTE_SETUP)
}

type Counts = { total: number; active: number }
const emptyCounts = (): Counts => ({ total: 0, active: 0 })

export default async function Setup() {
  if (!(await isAuthed())) redirect('/login')

  const projects = repo.listProjects()
  const all: Report[] = repo.listReports({ archived: 'all', limit: TICKET_CEILING })
  const truncated = all.length === TICKET_CEILING

  const counts = new Map<string, Counts>()
  for (const r of all) {
    const c = counts.get(r.projectId) ?? emptyCounts()
    c.total++
    if (!r.archived) c.active++
    counts.set(r.projectId, c)
  }

  return (
    <Shell active="setup">
      <main className="wrap">
        <SectionHeader
          lead
          title="Настройка"
          hint="Проекты и ключи — то, к чему возвращаются раз в месяц"
          actions={
            <Link className="keyconnect" href={ROUTE_CONNECT}>
              ⇗ Подключить агента
            </Link>
          }
        />

        <p className={s.lead}>
          Проект — это корзина, в которую падают тикеты, и у неё два ключа. <b>Ключ агента</b> отдают агенту: с ним
          он читает доску и меняет статусы. <b>Ключ расширения</b> вписывают в расширение браузера, чтобы новые
          съёмки попадали именно сюда. Ключи закрыты — нажмите «Показать», когда действительно нужно.
        </p>

        {truncated ? (
          <div className={s.warn}>
            Тикеты считаются по последним {TICKET_CEILING} — на доске их больше, числа у проектов занижены.
          </div>
        ) : null}

        <SectionHeader title="Проекты" count={projects.length} countTone="quiet" hint="каждый со своей парой ключей" />

        {projects.length === 0 ? (
          <EmptyState
            title="Ни одного проекта"
            hint="Заведите первый — ключи выдаются вместе с ним, и только после этого расширению и агентам есть куда писать."
          />
        ) : (
          <div className={s.projects}>
            {projects.map((p) => {
              const c = counts.get(p.id) ?? emptyCounts()
              return (
                <section className={s.proj} key={p.id}>
                  <div className={s.projhead}>
                    <span className={s.projname}>{p.name}</span>
                    <span className={s.projmeta} title={`Проект заведён ${exact(p.createdAt)}`}>
                      тикетов {c.total} · активных {c.active}
                    </span>
                    <Link className={s.projlink} href={`${ROUTE_TICKETS}?project=${encodeURIComponent(p.id)}`}>
                      Тикеты проекта →
                    </Link>
                  </div>

                  <div className={s.keys}>
                    {p.readKey ? (
                      <KeyField
                        label="ключ агента"
                        value={p.readKey}
                        hint={
                          <>
                            Читает доску и меняет статусы: <span className={s.keyenv}>{ENV_AGENT_KEY}</span> у MCP-сервера
                            агента, <span className={s.keyenv}>?projectKey=</span> у REST. Он же стоит в готовой команде
                            подключения.
                          </>
                        }
                      >
                        <details className={s.rot}>
                          <summary className={s.rotsum}>Сменить ключ агента</summary>
                          <form className={s.rotbody} action={regenerateKey}>
                            <input type="hidden" name="projectId" value={p.id} />
                            <span className={s.rottext}>
                              Старый ключ перестанет работать сразу. Все агенты этой доски отвалятся, пока им не выдадут
                              новую команду подключения.
                            </span>
                            <Button type="submit" variant="danger" size="sm">
                              Сменить
                            </Button>
                          </form>
                        </details>
                      </KeyField>
                    ) : (
                      <div className={s.key}>
                        <span className={s.keyk}>ключ агента</span>
                        <div className={s.keyless}>
                          У этой доски нет ключа агента — подключиться к ней нечем. Так бывает у досок, заведённых до
                          того, как ключи появились.
                          <form action={regenerateKey} className={s.keylessact}>
                            <input type="hidden" name="projectId" value={p.id} />
                            <Button type="submit" variant="primary" size="sm">
                              Выдать ключ
                            </Button>
                          </form>
                        </div>
                      </div>
                    )}

                    <KeyField
                      label="ключ расширения"
                      value={p.ingestKey}
                      hint={
                        <>
                          Куда расширение складывает съёмки: <span className={s.keyenv}>x-ingest-key</span> у POST
                          /api/ingest, <span className={s.keyenv}>{ENV_INGEST_KEY}</span> у агента, который сам ставит
                          тикеты.
                        </>
                      }
                    >
                      {/* Сказано вслух, потому что кнопки здесь нет и её отсутствие иначе читается как недоделка. */}
                      <p className={s.keyhint}>
                        Сменить нельзя: этим ключом подписаны все установленные расширения. Если он утёк — заводится
                        новый проект, и расширение переключают на него.
                      </p>
                    </KeyField>
                  </div>
                </section>
              )
            })}
          </div>
        )}

        <SectionHeader title="Новый проект" hint="ключи выдаются вместе с ним" />
        <form className={s.newproj} action={createProject}>
          <input
            name="name"
            className={s.newin}
            placeholder="название доски…"
            maxLength={MAX_PROJECT_NAME}
            required
          />
          <Button type="submit" variant="primary">
            Завести
          </Button>
          <p className={s.newhint}>
            Отдельный проект нужен там, где нужен отдельный ключ: другой сайт, другой заказчик, другая команда агентов.
            Внутри одного проекта тикеты и так разложены по сайтам, с которых сняты.
          </p>
        </form>

        <div className={s.foot}>
          <Link className={s.footlink} href={ROUTE_CONNECT}>
            Подключение агента: готовая команда →
          </Link>
          <Link className={s.footlink} href={ROUTE_KIT} title="Как выглядят общие части интерфейса">
            Набор деталей →
          </Link>
        </div>
      </main>
    </Shell>
  )
}
