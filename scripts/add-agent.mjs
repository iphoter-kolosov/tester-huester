#!/usr/bin/env node
// Подключение агента к доске одной командой — вместо трёх ручных шагов.
//
// Раньше это выглядело так: открыть панель, создать доску, скопировать ключ агента, скопировать ключ ingest,
// собрать руками строку `claude mcp add`, не забыть TH_AGENT, перезапустить агента. Забыть TH_AGENT — самая
// дешёвая из этих ошибок и самая дорогая по последствиям: записи подписываются ИМЕНЕМ ДОСКИ, агента нет в
// составе, адресовать ему работу нельзя. Четыре строки состава на боевой доске появились именно так.
// Здесь TH_AGENT не забывается: без него скрипт не доходит до записи.
//
//   node scripts/add-agent.mjs <доска> <handle> --dir <каталог агента>
//
// Пароль панели — только через переменную окружения TH_DASH_PASSWORD: аргументы остаются в истории оболочки и
// видны в списке процессов любому, кто на машине.
//
// Проверка: node scripts/add-agent-e2e.mjs (своя доска, свой дом, свой ~/.claude.json).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_COLLECTOR = 'https://qa.ihor.work'
const DEFAULT_SERVER_NAME = 'tester-huester'
const ENV_PASSWORD = 'TH_DASH_PASSWORD'
const ENV_PASSWORD_ALT = 'DASH_PASSWORD'
const ENV_COLLECTOR = 'TH_COLLECTOR'
const AUTH_COOKIE = 'th_auth'
/** Сколько символов ключа показывать. Терминал владельца могут писать на видео или смотреть через плечо —
 *  префикса хватает, чтобы отличить один ключ от другого, и не хватает, чтобы им воспользоваться. */
const SHOWN_PREFIX = 8
/** Границы «печатаемого» — ими канонизируется handle, как это делает normalizeIdentity на доске. */
const FIRST_PRINTABLE_CODE = 32
const DELETE_CODE = 127
/** Копия правила из packages/db/src/verify.ts: скрипт запускается голым `node`, без сборки, и импортировать
 *  TypeScript-пакет не может. Разъехаться незаметно оно не сможет — доска в конце отвечает уже канонизированным
 *  составом, и несовпадение будет видно там. */
const MAX_IDENTITY_LEN = 64

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = toPosix(path.resolve(here, '..'))
const CONFIG_FILE = path.join(os.homedir(), '.claude.json')

const USAGE = `
Подключить агента к доске tester-huester — одной командой.

  node scripts/add-agent.mjs <доска> <handle> [ключи]

  <доска>   как доска называется на панели, напр. "erental" (создаётся, если её нет)
  <handle>  имя агента, под которым он подписывает записи, напр. "erental"

  --dir <каталог>      каталог агента — тот, откуда он запускается (по умолчанию спросит)
  --collector <адрес>  адрес доски (по умолчанию ${ENV_COLLECTOR} или ${DEFAULT_COLLECTOR})
  --server <имя>       имя MCP-сервера в конфиге (по умолчанию ${DEFAULT_SERVER_NAME})
  --force              перезаписать уже существующую запись для этого каталога
  --help               эта справка

Пароль панели берётся из ${ENV_PASSWORD} (или ${ENV_PASSWORD_ALT}) — аргументом он не принимается.

  PowerShell:  $env:${ENV_PASSWORD} = '…'
  bash:        export ${ENV_PASSWORD}='…'
`

// Вывод синхронный, и это не стиль. process.stdout на Windows — асинхронная труба, и сообщение об отказе,
// написанное перед выходом, может не успеть уйти.
const out = (s) => fs.writeSync(1, s)
const errOut = (s) => fs.writeSync(2, s)

/**
 * Отказ. Именно исключение, а не process.exit: после двух и более сетевых запросов process.exit роняет libuv
 * на Windows («Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\\win\\async.c»), и владелец вместо
 * причины отказа получает код 3221226505. Поймано e2e на отказе «уже настроен». Процесс завершается сам, с
 * process.exitCode — так причина всегда доходит целиком.
 */
class Abort extends Error {
  constructor(lines) {
    super(lines.join(' '))
    this.lines = lines
  }
}
const fail = (...lines) => {
  throw new Abort(lines)
}

function toPosix(p) {
  // Claude Code хранит каталоги в ~/.claude.json с прямыми слэшами; запись с обратными — это ВТОРАЯ, чужая
  // запись для того же каталога, и агент её не увидит.
  const s = p.replace(/\\/g, '/')
  return s.replace(/(?<!:)\/+$/, '')
}

/** Показать ключ так, чтобы его можно было опознать и нельзя было использовать. */
const mask = (v) => (v ? `${v.slice(0, SHOWN_PREFIX)}…(${v.length} симв.)` : '(пусто)')

/** Значение переменной для показа: всё, в чьём ИМЕНИ есть KEY, — ключ. */
const showEnv = (name, value) => (name.includes('KEY') ? mask(value) : value)

/** То же, что normalizeIdentity на доске: доска канонизирует handle всё равно, и записать в конфиг стоит уже
 *  канонический — иначе TH_AGENT и подпись в тикетах выглядят по-разному. */
function canonicalHandle(raw) {
  const printable = [...String(raw ?? '')]
    .filter((ch) => {
      const code = ch.codePointAt(0)
      return code >= FIRST_PRINTABLE_CODE && code !== DELETE_CODE
    })
    .join('')
  return printable.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_IDENTITY_LEN).trim()
}

function parseArgs(argv) {
  const positional = []
  const flags = { force: false, help: false, dir: null, collector: null, server: null }
  const known = ['--dir', '--collector', '--server', '--force', '--help']
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--force') { flags.force = true; continue }
    if (arg === '--help' || arg === '-h') { flags.help = true; continue }
    if (arg === '--password' || arg === '-p') {
      fail(
        'Пароль аргументом не принимается — он остаётся в истории оболочки и виден в списке процессов.',
        `Положите его в ${ENV_PASSWORD}:  PowerShell: $env:${ENV_PASSWORD} = '…'   bash: export ${ENV_PASSWORD}='…'`,
      )
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      const inline = eq === -1 ? null : arg.slice(eq + 1)
      if (!known.includes(name)) fail(`Неизвестный ключ ${name}.`, `Есть только: ${known.join(', ')}.`, USAGE.trim())
      const value = inline ?? argv[++i]
      if (value == null) fail(`${name} требует значение.`)
      flags[name.slice(2)] = value
      continue
    }
    positional.push(arg)
  }
  if (positional.length > 2) {
    fail(
      `Лишние аргументы: ${positional.slice(2).join(' ')}.`,
      'Ожидается ровно два: <доска> и <handle>. Название из нескольких слов возьмите в кавычки.',
    )
  }
  return { flags, positional }
}

let rl = null
async function ask(question, fallback) {
  if (!process.stdin.isTTY) {
    fail(
      `Нечего спросить: ${question} — а ввода нет (запуск не из терминала).`,
      'Передайте значение аргументом или ключом --dir.',
    )
  }
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim()
  return answer || fallback || ''
}

async function api(collector, method, pathname, { body, cookie } = {}) {
  const url = `${collector}${pathname}`
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  let res
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    fail(`Доска не ответила: ${method} ${url}`, String(e?.message ?? e), 'Проверьте --collector и что доска поднята.')
  }
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    fail(
      `${method} ${url} → HTTP ${res.status}, а в ответе не JSON.`,
      `Начало ответа: ${text.slice(0, 160).replace(/\s+/g, ' ')}`,
      'Похоже, это не доска tester-huester.',
    )
  }
  return { res, data }
}

async function main() {
  // ── 1. что подключаем ────────────────────────────────────────────────────────────────────────────────────
  const { flags, positional } = parseArgs(process.argv.slice(2))
  if (flags.help) {
    out(USAGE)
    return
  }

  const serverName = (flags.server ?? DEFAULT_SERVER_NAME).trim()
  if (!serverName) fail('--server пустой: у MCP-сервера должно быть имя, под которым он лежит в конфиге.')

  const collectorRaw = (flags.collector ?? process.env[ENV_COLLECTOR] ?? DEFAULT_COLLECTOR).trim()
  if (!/^https?:\/\//.test(collectorRaw)) {
    fail(`Адрес доски "${collectorRaw}" без схемы.`, 'Нужен полный адрес: https://qa.ihor.work или http://127.0.0.1:4319.')
  }
  const collector = collectorRaw.replace(/\/+$/, '')

  const boardName = (positional[0] ?? (await ask('Название доски (как на панели)'))).trim()
  if (!boardName) fail('Без названия доски подключать не к чему.')

  const handleRaw = positional[1] ?? (await ask('Имя агента (handle), которым он подписывает записи'))
  const handle = canonicalHandle(handleRaw)
  if (!handle) {
    fail(
      'Без handle агента запись не делается — и это главное, ради чего скрипт написан.',
      'Без TH_AGENT агент подписывается ИМЕНЕМ ДОСКИ, в составе его нет, адресовать ему работу нельзя.',
    )
  }
  if (handle !== String(handleRaw).trim()) {
    out(`handle приведён к каноническому виду: "${String(handleRaw).trim()}" → "${handle}"\n`)
  }

  const targetDir = toPosix(path.resolve((flags.dir ?? (await ask('Каталог агента (откуда он запускается)', process.cwd()))).trim()))
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    fail(
      `Каталог "${targetDir}" не существует.`,
      'Запись в ~/.claude.json ключуется каталогом агента: для несуществующего она не сработает никогда и молча.',
    )
  }
  if (!fs.existsSync(path.join(REPO_DIR, 'apps', 'mcp', 'package.json'))) {
    fail(`В "${REPO_DIR}" нет apps/mcp — команда MCP-сервера из этой копии репозитория не запустится.`)
  }
  rl?.close()

  out(
    `\nдоска:    ${boardName} на ${collector}\n` +
    `агент:    ${handle}\n` +
    `каталог:  ${targetDir}\n` +
    `сервер:   ${serverName} (pnpm -C ${REPO_DIR} --filter @th/mcp remote)\n\n`,
  )

  // ── 2. вход на доску тем же паролем, что и в панели ───────────────────────────────────────────────────────
  out('1/5 вход на доску…\n')
  const password = process.env[ENV_PASSWORD] ?? process.env[ENV_PASSWORD_ALT] ?? ''
  const session = await api(collector, 'POST', '/api/session', { body: { password } })
  if (!session.data.ok) {
    fail(
      `Вход не принят (HTTP ${session.res.status}): ${session.data.message ?? session.data.error}`,
      `Пароль панели скрипт берёт из ${ENV_PASSWORD} (или ${ENV_PASSWORD_ALT}).`,
      `PowerShell: $env:${ENV_PASSWORD} = '…'   bash: export ${ENV_PASSWORD}='…'`,
    )
  }
  let cookie = null
  if (session.data.authRequired === false) {
    out('    доска без пароля (DASH_PASSWORD не задан) — вход не потребовался\n')
  } else {
    const setCookie = session.res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE}=`))
    if (!setCookie) fail('Доска приняла пароль, но не выдала куку th_auth — дальше идти нечем.')
    cookie = setCookie.split(';')[0]
    out('    вход выполнен\n')
  }

  // ── 3. доска и её ключи ───────────────────────────────────────────────────────────────────────────────────
  out(`2/5 доска «${boardName}»…\n`)
  const created = await api(collector, 'POST', '/api/projects', { body: { name: boardName }, cookie })
  if (!created.data.ok) {
    fail(`Доску получить не удалось (HTTP ${created.res.status}): ${created.data.message ?? created.data.error}`)
  }
  const project = created.data.project
  if (!project?.readKey || !project?.ingestKey) {
    fail('Доска ответила без ключей — записывать в конфиг нечего.', JSON.stringify(created.data).slice(0, 200))
  }
  out(
    `    ${created.data.created ? 'создана' : 'уже была'}: ${project.name}\n` +
    `    TH_PROJECT_KEY ${mask(project.readKey)}\n` +
    `    TH_INGEST_KEY  ${mask(project.ingestKey)}\n`,
  )

  // ── 4. запись в ~/.claude.json ────────────────────────────────────────────────────────────────────────────
  out(`3/5 запись в ${CONFIG_FILE}…\n`)
  if (!fs.existsSync(CONFIG_FILE)) {
    fail(
      `Конфига ${CONFIG_FILE} нет.`,
      'Его создаёт само приложение агента — запустите Claude Code хотя бы раз, потом повторите. Свой скрипт здесь не пишет.',
    )
  }
  const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8')
  let config
  try {
    config = JSON.parse(rawConfig)
  } catch (e) {
    fail(`${CONFIG_FILE} уже не разбирается как JSON: ${String(e?.message ?? e)}`, 'Чинить его вслепую скрипт не будет.')
  }

  const entry = {
    type: 'stdio',
    command: 'pnpm',
    args: ['-C', REPO_DIR, '--filter', '@th/mcp', 'remote'],
    env: {
      TH_COLLECTOR: collector,
      TH_PROJECT_KEY: project.readKey,
      TH_AGENT: handle,
      TH_INGEST_KEY: project.ingestKey,
    },
  }

  config.projects ??= {}
  // Каталог может быть агенту ещё не знаком — тогда заводим запись только с mcpServers, остальные поля Claude
  // Code допишет сам при первом запуске в этом каталоге.
  config.projects[targetDir] ??= {}
  config.projects[targetDir].mcpServers ??= {}
  const existing = config.projects[targetDir].mcpServers[serverName]
  if (existing && !flags.force) {
    const describe = (e) =>
      [
        `    command: ${e.command} ${(e.args ?? []).join(' ')}`,
        ...Object.entries(e.env ?? {}).map(([k, v]) => `    ${k}: ${showEnv(k, String(v))}`),
      ].join('\n  ')
    fail(
      `сервер "${serverName}" для каталога ${targetDir} уже настроен. Молча перезаписывать не буду.`,
      '',
      'сейчас:',
      describe(existing),
      '',
      'стало бы:',
      describe(entry),
      '',
      'Если это и нужно — повторите ту же команду с --force.',
    )
  }
  config.projects[targetDir].mcpServers[serverName] = entry

  // Метка с миллисекундами: два запуска подряд укладываются в одну секунду, и копия, затёртая другой копией,
  // — ровно та молчаливая потеря, от которой копия и защищает.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '-$1').replace('T', '-')
  const backup = `${CONFIG_FILE}.bak-${stamp}`
  fs.copyFileSync(CONFIG_FILE, backup)
  // Формат файла сохраняем как был: приложение пишет его компактно, и разворачивать чужой конфиг в тысячи строк
  // ради одной записи — это диff, в котором правку уже не найти.
  const pretty = rawConfig.includes('\n')
  const next = JSON.stringify(config, null, pretty ? 2 : 0) + (rawConfig.endsWith('\n') ? '\n' : '')
  fs.writeFileSync(CONFIG_FILE, next, 'utf8')

  // Доказательство, а не намерение: файл перечитывается С ДИСКА. Испорченный ~/.claude.json стоит несравнимо
  // дороже минуты, которую экономит скрипт, поэтому откат — прямо здесь, а не в советах владельцу.
  try {
    JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (e) {
    fs.copyFileSync(backup, CONFIG_FILE)
    fail(
      'ЗАПИСЬ ИСПОРТИЛА КОНФИГ — файл восстановлен из резервной копии, изменений нет.',
      String(e?.message ?? e),
      `Копия на всякий случай: ${backup}`,
    )
  }
  out(`    записано; резервная копия ${path.basename(backup)}\n`)

  // ── 5. проверка: тем ли ключом и живой ли он ──────────────────────────────────────────────────────────────
  out('4/5 проверка ключа на доске…\n')
  const roster = await api(collector, 'GET', `/api/agents?projectKey=${encodeURIComponent(project.readKey)}`)
  if (!roster.data.ok) {
    fail(
      `Ключ записан, но доска по нему не отвечает (HTTP ${roster.res.status}): ${roster.data.message ?? roster.data.error}`,
      `Конфиг изменён — откатить можно из ${backup}.`,
    )
  }
  const known = (roster.data.agents ?? []).find((a) => a.handle === handle)
  out(`    ключ работает, в составе ${roster.data.count} агентов\n`)
  out('5/5 готово.\n\n')

  // ── что осталось человеку ─────────────────────────────────────────────────────────────────────────────────
  out(
    `ОСТАЛОСЬ ОДНО: перезапустите приложение агента в каталоге ${targetDir}.\n` +
    'MCP-серверы читаются один раз при старте — без перезапуска агент работает со старым списком инструментов\n' +
    'и сообщает, что их не существует.\n\n',
  )
  if (!known) {
    out(
      `Агента "${handle}" в составе доски пока нет — он появится там сам, первой же записью.\n` +
      'Чтобы ему можно было адресовать работу, при первом подключении он должен вызвать\n' +
      'register_agent {title, role}: без роли доска не даст ему передать тикет коллеге (role_required).\n\n',
    )
  } else if (!known.role) {
    out(
      `Агент "${handle}" в составе есть, но без роли — передать тикет коллеге доска ему не даст (role_required).\n` +
      'Пусть при подключении вызовет register_agent {title, role}.\n\n',
    )
  }
}

try {
  await main()
} catch (e) {
  errOut(
    e instanceof Abort
      ? `\nНЕ СДЕЛАНО: ${e.lines.join('\n  ')}\n`
      : `\nНЕ СДЕЛАНО: непредвиденная ошибка, ничего не записано.\n  ${String(e?.stack ?? e)}\n`,
  )
  process.exitCode = 1
} finally {
  rl?.close()
}
