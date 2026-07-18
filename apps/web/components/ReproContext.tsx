'use client'

import { useState } from 'react'
import type { ReproBundle, ActionStep, ConsoleEntry, NetworkEntry } from '@th/core'

// The repro bundle rendered as tabs. This is the human half of "one capture, two consumers" — the same
// JSON an AI agent reads over MCP. Kept dependency-light: type-only import from @th/core (erased at build),
// formatting done locally so the capture lib's browser deps never reach this bundle.
export default function ReproContext({ context }: { context: ReproBundle }) {
  const actions = context.actions ?? []
  const cons = context.console ?? []
  const net = context.network ?? []
  const tabs = [
    { key: 'steps', label: 'Steps', n: actions.length },
    { key: 'console', label: 'Console', n: cons.length },
    { key: 'network', label: 'Network', n: net.length },
    { key: 'env', label: 'Env', n: 0 },
  ].filter((t) => t.key === 'env' || t.n > 0)
  const [tab, setTab] = useState(tabs[0]?.key ?? 'env')
  if (tabs.length === 0) return null
  const errors = cons.filter((c) => c.level === 'error').length

  return (
    <div className="ctx">
      <div className="ctxhead">
        <span className="ctxttl">Repro context</span>
        {errors > 0 && <span className="ctxerr">{errors} error{errors > 1 ? 's' : ''}</span>}
      </div>
      <div className="ctxtabs">
        {tabs.map((t) => (
          <button key={t.key} className={'ctxtab' + (tab === t.key ? ' on' : '')} onClick={() => setTab(t.key)}>
            {t.label}
            {t.n > 0 && <span className="ctxn">{t.n}</span>}
          </button>
        ))}
      </div>
      <div className="ctxbody">
        {tab === 'steps' && <Steps actions={actions} />}
        {tab === 'console' && <ConsoleView rows={cons} />}
        {tab === 'network' && <NetworkView rows={net} />}
        {tab === 'env' && <EnvView env={context.env} />}
      </div>
    </div>
  )
}

function Steps({ actions }: { actions: ActionStep[] }) {
  if (!actions.length) return <div className="ctxempty">No recorded actions.</div>
  return (
    <ol className="steps">
      {actions.map((a, i) => (
        <li key={i}>
          <span className="stept">{describeStep(a)}</span>
          <code className="stepsel">{a.selector.css}</code>
        </li>
      ))}
    </ol>
  )
}

function ConsoleView({ rows }: { rows: ConsoleEntry[] }) {
  return (
    <div className="logs">
      {rows.map((c, i) => (
        <div key={i} className={'logline lv-' + c.level}>
          <span className="lvl">{c.level}</span>
          <span className="ltext">{c.text}</span>
        </div>
      ))}
    </div>
  )
}

function NetworkView({ rows }: { rows: NetworkEntry[] }) {
  return (
    <table className="net">
      <tbody>
        {rows.map((n, i) => (
          <tr key={i} className={n.status === 0 || n.status >= 400 ? 'bad' : ''}>
            <td className="nm">{n.method}</td>
            <td className="ns">{n.status || 'ERR'}</td>
            <td className="nu" title={n.url}>{n.url}</td>
            <td className="nt">{n.ms}ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function EnvView({ env }: { env: ReproBundle['env'] }) {
  if (!env) return <div className="ctxempty">No environment captured.</div>
  const rows: [string, string | undefined][] = [
    ['URL', env.url],
    ['Browser', env.browser],
    ['OS', env.os],
    ['Viewport', env.viewport],
    ['DPR', env.dpr != null ? String(env.dpr) : undefined],
    ['Timezone', env.timezone],
    ['Languages', env.languages?.join(', ')],
    ['Connection', env.connection],
    ['User agent', env.userAgent],
  ]
  return (
    <div className="envgrid">
      {rows.map(([k, v]) => (
        <div className="envrow" key={k}>
          <span className="envk">{k}</span>
          <span className="envv">{v || '—'}</span>
        </div>
      ))}
    </div>
  )
}

// Mirror of @th/core's reproSteps formatting — display concern, kept local to avoid bundling capture deps.
function describeStep(a: ActionStep): string {
  const target = a.selector.name || a.selector.text || a.selector.testid || a.selector.css
  const via = a.selector.role ? `${a.selector.role} "${target}"` : `"${target}"`
  switch (a.type) {
    case 'click':
      return `Click ${via}`
    case 'input':
    case 'change':
      return `Type ${a.value ? `"${a.value}" ` : ''}into ${via}`
    case 'submit':
      return `Submit ${via}`
    case 'key':
      return `Press ${a.key} on ${via}`
    default:
      return `${a.type} ${via}`
  }
}
