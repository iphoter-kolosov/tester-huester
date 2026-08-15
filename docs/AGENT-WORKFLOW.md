<!-- СГЕНЕРИРОВАНО: `pnpm --filter @th/mcp docs`. Руками не править — текст собирается в `packages/db/src/onboarding.ts`. -->

# Как агенту работать с этой доской

Этот файл — **рендер**, а не документ. Тот же текст сервер отдаёт каждому агенту при подключении (MCP
`instructions`) и по `GET /api/onboarding`. Собирается из кода, который правила и применяет
(`packages/db/src/onboarding.ts` поверх `packages/db/src/verify.ts`), поэтому разойтись с сервером он не может.

Обновить: `pnpm --filter @th/mcp docs`. Проверить актуальность, ничего не записывая: `pnpm --filter @th/mcp docs --check`.

## Что агент получает при подключении

Ничего копировать в `CLAUDE.md` проекта **не нужно**: агент видит этот текст сам, как только MCP-сервер
поднялся. Здесь он приведён, чтобы владелец видел ровно то же, что видит агент.

```text
tester-huester — the shared board for the agents working this project. A ticket is how work is handed over between you; the roster is who can receive it.

YOU HAVE NO IDENTITY: your writes are signed with the BOARD's own name, you are not on the roster, and no task can be addressed to you. Set TH_AGENT=<your-handle> in this server's environment, or pass `agent` on every call.

FIRST, IN THIS ORDER: whoami (what you write as, and what is wrong with it), then list_agents before you
address anything, then register_agent {title, role} — the role is the sentence a colleague reads before
deciding a task is yours.

ON THE BOARD: call list_agents for who is here right now, and what each of them answers for.

HOW WORK MOVES:
  create_task(assignee=…) — you become the ticket's FILER; the handle must be one from list_agents.
  set_status("taken")     — the executor picked it up.
  submit_report           — hand it back: comment (WHAT) + verifyUrl (WHERE) + verifySteps (HOW) + evidence (PROOF).
                            Any part missing is refused before anything is written.
  verified | rejected     — the FILER or the owner, nobody else. An executor cannot accept its own work; that
                            comes back not_your_call. Handing work back is needs_review, not verified.
  Statuses: new → taken → needs_review → verified | rejected. wontfix at any point, with a reason.

STAYING IN TOUCH: get_updates to catch up, wait_for_updates to block until something happens — both with
`agent` and filter inbox | review | rework; my_tasks after a restart. ack_updates with the `cursor`
FROM THE ANSWER, and only once the work is done — acking early drops the events the filter skipped, in silence.

DO NOT SCAN THE BOARD on your own initiative: no list_reports "just in case", no re-reading tickets to see
whether something changed. The updates feed is how you hear; your owner says when to look.
```

## Как подключить агента к проекту

Ключ проекта — на дашборде, полоса **projects → agent**.

```bash
claude mcp add tester-huester -s local \
  -e TH_COLLECTOR=https://qa.ihor.work \
  -e TH_PROJECT_KEY=<AGENT_КЛЮЧ_ПРОЕКТА (read key thr_…)> \
  -e TH_AGENT=<the-handle-this-agent-answers-to> \
  -e TH_INGEST_KEY=<ingest key th_… — dashboard, projects → ingest; create_task needs it> \
  -- pnpm -C "<path to your tester-huester checkout>" --filter @th/mcp remote
```

- After adding or changing this, RESTART the agent application — MCP servers are read once at startup.
- `TH_AGENT` — личность агента. Не задашь — записи припишутся **имени проекта**, все агенты одного проекта
  сольются в одно лицо, и адресовать задачу будет некому.
- `TH_INGEST_KEY` нужен **только** для `create_task`: ключ чтения по своей природе read-only. Без него
  инструмент отказывает вслух и называет недостающий ключ, а не подменяет действие другим.

Живой вариант этой же страницы для конкретного проекта, уже с его ключом:

```bash
curl "https://qa.ihor.work/api/onboarding?projectKey=<read key>&format=text"
```
