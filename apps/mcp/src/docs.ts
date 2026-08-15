import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConnectSnippet, buildInstructions, CONNECT_RESTART_NOTE, REPO_PATH_PLACEHOLDER } from '@th/db'

// Generates docs/AGENT-WORKFLOW.md from the SAME builder the MCP servers and GET /api/onboarding use.
//
//   pnpm --filter @th/mcp docs           write the file
//   pnpm --filter @th/mcp docs --check    fail if it is out of date (exit 1), write nothing
//
// The file used to be hand-written, and it drifted: it still described four statuses and the old two-part closing
// contract long after the code had moved on. A document that CAN disagree with the enforcement eventually does, so
// this one is not a document any more — it is a rendering.
//
// The frame around the block is Russian because the owner reads it; the block itself is left exactly as an agent
// receives it, in English, which is also the point of showing it here at all.

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(here, '../../..')
const TARGET = path.join(REPO_ROOT, 'docs', 'AGENT-WORKFLOW.md')

/** The public collector. Only an example inside the snippet — every deployment serves its own from /api/onboarding. */
const EXAMPLE_COLLECTOR = 'https://qa.ihor.work'
const EXAMPLE_READ_KEY = '<AGENT_КЛЮЧ_ПРОЕКТА (read key thr_…)>'
const GENERATOR = 'pnpm --filter @th/mcp docs'
const SOURCE_MODULE = 'packages/db/src/onboarding.ts'

/**
 * The greeting as a not-yet-connected reader must see it: no board, no identity, and the roster deliberately left
 * unresolved. Baking the live roster into a committed file would put a snapshot of who was working on the day of
 * generation into git, where it would rot exactly the way the old hand-written text did.
 */
const instructions = buildInstructions({
  boardName: null,
  identity: { kind: 'unknown' },
  roster: { kind: 'notLookedUp' },
})

const snippet = buildConnectSnippet({
  collector: EXAMPLE_COLLECTOR,
  readKey: EXAMPLE_READ_KEY,
  repoPath: REPO_PATH_PLACEHOLDER,
})

const page = [
  `<!-- СГЕНЕРИРОВАНО: \`${GENERATOR}\`. Руками не править — текст собирается в \`${SOURCE_MODULE}\`. -->`,
  '',
  '# Как агенту работать с этой доской',
  '',
  `Этот файл — **рендер**, а не документ. Тот же текст сервер отдаёт каждому агенту при подключении (MCP`,
  '`instructions`) и по `GET /api/onboarding`. Собирается из кода, который правила и применяет',
  `(\`${SOURCE_MODULE}\` поверх \`packages/db/src/verify.ts\`), поэтому разойтись с сервером он не может.`,
  '',
  `Обновить: \`${GENERATOR}\`. Проверить актуальность, ничего не записывая: \`${GENERATOR} --check\`.`,
  '',
  '## Что агент получает при подключении',
  '',
  'Ничего копировать в `CLAUDE.md` проекта **не нужно**: агент видит этот текст сам, как только MCP-сервер',
  'поднялся. Здесь он приведён, чтобы владелец видел ровно то же, что видит агент.',
  '',
  '```text',
  instructions,
  '```',
  '',
  '## Как подключить агента к проекту',
  '',
  'Ключ проекта — на дашборде, полоса **projects → agent**.',
  '',
  '```bash',
  snippet,
  '```',
  '',
  `- ${CONNECT_RESTART_NOTE}`,
  '- `TH_AGENT` — личность агента. Не задашь — записи припишутся **имени проекта**, все агенты одного проекта',
  '  сольются в одно лицо, и адресовать задачу будет некому.',
  '- `TH_INGEST_KEY` нужен **только** для `create_task`: ключ чтения по своей природе read-only. Без него',
  '  инструмент отказывает вслух и называет недостающий ключ, а не подменяет действие другим.',
  '',
  'Живой вариант этой же страницы для конкретного проекта, уже с его ключом:',
  '',
  '```bash',
  `curl "${EXAMPLE_COLLECTOR}/api/onboarding?projectKey=<read key>&format=text"`,
  '```',
  '',
].join('\n')

const check = process.argv.includes('--check')
const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null

if (check) {
  if (current === page) {
    console.log(`docs: ${path.relative(REPO_ROOT, TARGET)} is up to date ✓`)
    process.exit(0)
  }
  // Loud and specific: a stale doc is the exact defect this generator exists to remove, so it fails the run
  // rather than quietly rewriting the file behind a reviewer's back.
  console.error(
    `docs: ${path.relative(REPO_ROOT, TARGET)} is ${current === null ? 'MISSING' : 'STALE'} — run \`${GENERATOR}\` and commit the result.`,
  )
  process.exit(1)
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true })
fs.writeFileSync(TARGET, page, 'utf8')
console.log(`docs: wrote ${path.relative(REPO_ROOT, TARGET)} (${page.length} chars)`)
