'use client'
import { useRouter, useSearchParams } from 'next/navigation'

type Opt = { value: string; label: string }

const TYPES: Opt[] = [
  { value: 'feature', label: 'Фича' },
  { value: 'bug', label: 'Баг' },
  { value: 'fix', label: 'Правка' },
  { value: 'text', label: 'Текст' },
]
const STATUSES: Opt[] = [
  { value: 'new', label: 'new' },
  { value: 'triaged', label: 'triaged' },
  { value: 'fixed', label: 'fixed' },
  { value: 'wontfix', label: 'wontfix' },
]

// The QA-cabinet toolbar. Every control applies IMMEDIATELY on change (no Filter button) by rewriting the URL
// search params; the server component re-queries. Active/Archive is a tab pair on the same mechanism.
export default function Filters({ sites, projects, archivedCount }: { sites: Opt[]; projects: Opt[]; archivedCount: number }) {
  const router = useRouter()
  const sp = useSearchParams()
  const cur = (k: string) => sp.get(k) || ''
  const arch = cur('arch') === '1'

  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams(sp.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    router.push(p.toString() ? `/?${p}` : '/')
  }

  const hasFilter = !!(cur('site') || cur('type') || cur('status') || cur('project'))

  return (
    <div className="bar">
      <div className="tabs">
        <button className={'tab' + (!arch ? ' on' : '')} onClick={() => go({ arch: '' })}>Активные</button>
        <button className={'tab' + (arch ? ' on' : '')} onClick={() => go({ arch: '1' })}>
          Архив{archivedCount ? <span className="tabn">{archivedCount}</span> : null}
        </button>
      </div>

      <div className="filts">
        <select className="fc" value={cur('site')} onChange={(e) => go({ site: e.target.value })}>
          <option value="">Все сайты</option>
          {sites.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {projects.length > 1 && (
          <select className="fc" value={cur('project')} onChange={(e) => go({ project: e.target.value })}>
            <option value="">Все проекты</option>
            {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        )}
        <select className="fc" value={cur('type')} onChange={(e) => go({ type: e.target.value })}>
          <option value="">Любой тип</option>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className="fc" value={cur('status')} onChange={(e) => go({ status: e.target.value })}>
          <option value="">Любой статус</option>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select className="fc" value={cur('sort') || 'new'} onChange={(e) => go({ sort: e.target.value === 'old' ? 'old' : '' })}>
          <option value="new">Сначала новые</option>
          <option value="old">Сначала старые</option>
        </select>
        {(hasFilter || cur('sort')) && (
          <button className="fclear" onClick={() => go({ site: '', type: '', status: '', project: '', sort: '' })}>Сбросить</button>
        )}
      </div>
    </div>
  )
}
