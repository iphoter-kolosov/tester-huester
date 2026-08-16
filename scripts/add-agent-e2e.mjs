#!/usr/bin/env node
// Проверка установщика на настоящем сервере, настоящей куке и НАСТОЯЩЕМ файле конфига.
//
//   node scripts/add-agent-e2e.mjs
//
// Всё одноразовое: своя база, свой домашний каталог (USERPROFILE/HOME), свой ~/.claude.json. Ни боевая доска,
// ни конфиг владельца здесь не участвуют — иначе цена ошибки в тесте была бы выше цены самой ошибки.
//
// Проверяется ровно то, что стоит денег, если сломается молча: что скрипт не пишет без пароля, не затирает
// чужую запись, не портит JSON, не печатает ключи целиком — и что записанные ключи доска действительно
// принимает (ключ, который выглядит ключом, но не работает, обнаружился бы только у агента).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(here, '..')
const webDir = path.join(repoDir, 'apps', 'web')
const installer = path.join(here, 'add-agent.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-installer-'))
const dbFile = path.join(tmp, 'th.db')
const home = path.join(tmp, 'home')
const agentDir = path.join(tmp, 'agent')
const otherDir = path.join(tmp, 'other-agent')
const configFile = path.join(home, '.claude.json')
// Второй «дом» — с конфигом в том виде, в каком он лежит у владельца НА САМОМ ДЕЛЕ: 2377 строк с отступом в два
// пробела. Проверка только на однострочном конфиге пропустила бы переформатирование именно того файла, который
// дороже всего.
const prettyHome = path.join(tmp, 'home-pretty')
const prettyDir = path.join(tmp, 'pretty-agent')
const prettyConfigFile = path.join(prettyHome, '.claude.json')
for (const d of [home, agentDir, otherDir, prettyHome, prettyDir]) fs.mkdirSync(d, { recursive: true })

const PASSWORD = 'installer-probe-password'
const PORT = 4900 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`
const BOARD = 'Инсталлятор'
const FOREIGN_DIR = 'C:/somewhere/else'

// Конфиг пишется одной строкой — ровно как его пишет приложение. Формат исходника проверяется потом: развернуть
// чужой конфиг в тысячи строк ради одной записи значит спрятать правку в диффе.
const originalConfig = JSON.stringify({
  numStartups: 7,
  projects: {
    [FOREIGN_DIR]: { allowedTools: [], mcpServers: { 'some-other-server': { type: 'stdio', command: 'node', args: ['x.js'] } } },
  },
})
fs.writeFileSync(configFile, originalConfig, 'utf8')
const prettyConfig = JSON.stringify(JSON.parse(originalConfig), null, 2)
fs.writeFileSync(prettyConfigFile, prettyConfig, 'utf8')

let failed = 0
const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`✓ ${name}`)
  } catch (e) {
    failed++
    results.push(`✗ ${name}\n    ${String(e?.message ?? e).split('\n').join('\n    ')}`)
  }
}

const readConfig = () => fs.readFileSync(configFile, 'utf8')
// Каталог в ~/.claude.json ключуется с прямыми слэшами — искать по windows-пути значит не найти свою же запись.
const dirKey = (dir) => path.resolve(dir).replace(/\\/g, '/')
const entryOf = (dir, server = 'tester-huester') => JSON.parse(readConfig()).projects?.[dirKey(dir)]?.mcpServers?.[server] ?? null
const backups = () => fs.readdirSync(home).filter((f) => f.startsWith('.claude.json.bak-'))

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [installer, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, TH_COLLECTOR: BASE, TH_DASH_PASSWORD: '', DASH_PASSWORD: '', ...env },
  })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

const child = spawn(process.execPath, [path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], {
  cwd: webDir,
  env: { ...process.env, SQLITE_FILE: dbFile, UPLOAD_DIR: path.join(tmp, 'uploads'), DASH_PASSWORD: PASSWORD },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr?.on('data', (d) => process.stderr.write(`[next] ${d}`))

try {
  let up = false
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/agents`)
      if (r.status < 500) { up = true; break }
    } catch {
      // ещё не слушает
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!up) throw new Error(`сервер не поднялся на ${BASE} — проверять нечего (нужен pnpm --filter web build)`)
  console.log(`доска поднята на ${BASE} (next start, одноразовая база), дом: ${home}`)

  // ── отказы, которые обязаны случиться ДО любой записи ────────────────────────────────────────────────────
  const before = readConfig()

  const noPassword = run([BOARD, 'probe-agent', '--dir', agentDir])
  check('1 без пароля в окружении — отказ, и он называет переменную', () => {
    assert.equal(noPassword.code, 1)
    assert.ok(noPassword.err.includes('TH_DASH_PASSWORD'), noPassword.err)
    assert.equal(readConfig(), before, 'конфиг не должен был измениться')
  })

  const wrongPassword = run([BOARD, 'probe-agent', '--dir', agentDir], { TH_DASH_PASSWORD: 'nope' })
  check('2 неверный пароль — отказ доски доходит до владельца дословно', () => {
    assert.equal(wrongPassword.code, 1)
    assert.ok(/Wrong dashboard password/.test(wrongPassword.err), wrongPassword.err)
    assert.equal(readConfig(), before)
  })

  const asArgument = run([BOARD, 'probe-agent', '--dir', agentDir, '--password', PASSWORD], { TH_DASH_PASSWORD: PASSWORD })
  check('3 пароль аргументом не принимается вовсе', () => {
    assert.equal(asArgument.code, 1)
    assert.ok(asArgument.err.includes('истории оболочки'), asArgument.err)
    assert.equal(readConfig(), before)
  })

  const missingDir = run([BOARD, 'probe-agent', '--dir', path.join(tmp, 'no-such-dir')], { TH_DASH_PASSWORD: PASSWORD })
  check('4 несуществующий каталог агента — отказ (запись для него не сработала бы никогда и молча)', () => {
    assert.equal(missingDir.code, 1)
    assert.ok(missingDir.err.includes('не существует'), missingDir.err)
    assert.equal(readConfig(), before)
  })

  // ── собственно подключение ───────────────────────────────────────────────────────────────────────────────
  const ok = run([BOARD, 'Probe-Agent', '--dir', agentDir], { TH_DASH_PASSWORD: PASSWORD })
  let entry = null
  check('5 подключение проходит и пишет запись для каталога агента', () => {
    assert.equal(ok.code, 0, ok.err || ok.out)
    entry = entryOf(agentDir)
    assert.ok(entry, `нет записи для ${agentDir}: ${readConfig().slice(0, 400)}`)
    assert.equal(entry.command, 'pnpm')
    assert.deepEqual(entry.args, ['-C', repoDir.replace(/\\/g, '/'), '--filter', '@th/mcp', 'remote'])
  })

  check('6 в записи есть ВСЕ четыре переменные, включая TH_AGENT — ради него всё и написано', () => {
    assert.deepEqual(Object.keys(entry.env).sort(), ['TH_AGENT', 'TH_COLLECTOR', 'TH_INGEST_KEY', 'TH_PROJECT_KEY'])
    assert.equal(entry.env.TH_COLLECTOR, BASE)
    assert.equal(entry.env.TH_AGENT, 'probe-agent', 'handle приводится к каноническому виду доски')
  })

  // Дальше всё опирается на записанную запись: без неё остальные проверки будут врать «зелёным» на пустоте.
  if (!entry) {
    throw new Error(
      `записи нет, проверять дальше нечего.\n${results.join('\n')}\nкод установщика: ${ok.code}\n${ok.out}\n${ok.err}`,
    )
  }

  await (async () => {
    const roster = await fetch(`${BASE}/api/agents?projectKey=${encodeURIComponent(entry.env.TH_PROJECT_KEY)}`)
    const rosterBody = await roster.json()
    const ingest = await fetch(`${BASE}/api/projects?ingestKey=${encodeURIComponent(entry.env.TH_INGEST_KEY)}`)
    const ingestBody = await ingest.json()
    check('7 доска принимает ОБА записанных ключа — они настоящие, а не просто похожие на ключи', () => {
      assert.equal(rosterBody.ok, true, JSON.stringify(rosterBody))
      assert.equal(ingestBody.ok, true, JSON.stringify(ingestBody))
    })
  })()

  check('8 ключи не печатаются целиком: в выводе только префиксы', () => {
    assert.ok(!ok.out.includes(entry.env.TH_PROJECT_KEY), 'read key утёк в stdout целиком')
    assert.ok(!ok.out.includes(entry.env.TH_INGEST_KEY), 'ingest key утёк в stdout целиком')
    assert.ok(ok.out.includes(entry.env.TH_PROJECT_KEY.slice(0, 8)), 'префикс ключа показать всё же надо')
  })

  check('9 чужие части конфига целы, формат файла не переписан', () => {
    const cfg = JSON.parse(readConfig())
    assert.equal(cfg.numStartups, 7)
    assert.ok(cfg.projects[FOREIGN_DIR]?.mcpServers?.['some-other-server'], 'чужая запись пропала')
    assert.ok(!readConfig().includes('\n'), 'файл был однострочным — таким и должен остаться')
  })

  check('10 резервная копия сделана и разбирается как JSON', () => {
    const made = backups()
    assert.equal(made.length, 1, `копий: ${made.length}`)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, made[0]), 'utf8')), JSON.parse(before))
  })

  check('11 владельцу сказано ровно одно оставшееся действие — перезапуск', () => {
    assert.ok(ok.out.includes('ОСТАЛОСЬ ОДНО'), ok.out)
    assert.ok(/перезапустите приложение агента/i.test(ok.out), ok.out)
    assert.ok(ok.out.includes('register_agent'), 'агента нет в составе — про роль надо сказать')
  })

  // ── повторный запуск ─────────────────────────────────────────────────────────────────────────────────────
  const beforeSecond = readConfig()
  const clobber = run([BOARD, 'other-handle', '--dir', agentDir], { TH_DASH_PASSWORD: PASSWORD })
  check('12 существующая запись молча не затирается — видно, что есть и что стало бы', () => {
    assert.equal(clobber.code, 1)
    assert.ok(clobber.err.includes('уже настроен'), clobber.err)
    assert.ok(clobber.err.includes('--force'), clobber.err)
    assert.ok(clobber.err.includes('probe-agent') && clobber.err.includes('other-handle'), 'обе стороны должны быть названы')
    assert.ok(!clobber.err.includes(entry.env.TH_PROJECT_KEY), 'и здесь ключ целиком печатать нельзя')
    assert.equal(readConfig(), beforeSecond, 'без --force конфиг не меняется')
  })

  const forced = run([BOARD, 'other-handle', '--dir', agentDir, '--force'], { TH_DASH_PASSWORD: PASSWORD })
  check('13 с --force запись обновляется', () => {
    assert.equal(forced.code, 0, forced.err || forced.out)
    assert.equal(entryOf(agentDir).env.TH_AGENT, 'other-handle')
    assert.equal(backups().length, 2)
  })

  const reused = run(['инсталлятор', 'second-agent', '--dir', otherDir], { TH_DASH_PASSWORD: PASSWORD })
  check('14 та же доска другим регистром — не второй проект, а тот же (ключи совпадают)', () => {
    assert.equal(reused.code, 0, reused.err || reused.out)
    const second = entryOf(otherDir)
    assert.equal(second.env.TH_PROJECT_KEY, entry.env.TH_PROJECT_KEY)
    assert.equal(second.env.TH_INGEST_KEY, entry.env.TH_INGEST_KEY)
    assert.ok(reused.out.includes('уже была'), reused.out)
  })

  const onPretty = run([BOARD, 'pretty-agent', '--dir', prettyDir], { TH_DASH_PASSWORD: PASSWORD, USERPROFILE: prettyHome, HOME: prettyHome })
  check('15 конфиг с отступами (как у владельца) остаётся с отступами, чужое цело', () => {
    assert.equal(onPretty.code, 0, onPretty.err || onPretty.out)
    const after = fs.readFileSync(prettyConfigFile, 'utf8')
    const parsed = JSON.parse(after)
    assert.equal(after, JSON.stringify(parsed, null, 2), 'файл перестал быть двухпробельным')
    assert.equal(parsed.numStartups, 7)
    assert.ok(parsed.projects[FOREIGN_DIR]?.mcpServers?.['some-other-server'])
    assert.equal(parsed.projects[dirKey(prettyDir)].mcpServers['tester-huester'].env.TH_AGENT, 'pretty-agent')
    // Диff должен быть ровно про добавленную запись: всё до "projects" обязано совпасть побайтно.
    const head = prettyConfig.slice(0, prettyConfig.indexOf('"projects"'))
    assert.ok(after.startsWith(head), 'начало файла переписано — правку в таком диффе уже не найти')
  })
} finally {
  child.kill()
}

console.log(`\n${results.join('\n')}\n`)
console.log(failed ? `ПРОВАЛ: ${failed} из ${results.length}` : `все ${results.length} проверок пройдены`)
process.exit(failed ? 1 : 0)
