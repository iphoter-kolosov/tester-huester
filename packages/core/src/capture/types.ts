// The "repro bundle" — the machine-readable context that turns a screenshot into something a developer
// (or an AI agent, over MCP) can actually reproduce from. One capture, two consumers: human + agent.

export type SelectorCandidates = {
  css: string // shortest unique CSS (from @medv/finder)
  role?: string // ARIA/implicit role
  name?: string // accessible name (aria-label / alt / placeholder / text)
  text?: string // trimmed visible text
  testid?: string // data-testid / data-test
}

export type ConsoleEntry = { level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; ts: number }

export type NetworkEntry = {
  method: string
  url: string
  status: number // 0 = failed/aborted
  ms: number
  kind: 'fetch' | 'xhr'
  error?: string
  ts: number
}

export type ActionStep = {
  type: 'click' | 'input' | 'change' | 'submit' | 'key'
  selector: SelectorCandidates
  value?: string // masked
  key?: string // for 'key' (Enter/Escape/…)
  url: string
  ts: number
}

export type EnvInfo = {
  url: string
  userAgent: string
  browser?: string
  os?: string
  viewport: string // "WxH"
  dpr: number
  timezone?: string
  languages?: string[]
  connection?: string // effectiveType
}

export type ReproBundle = {
  env: EnvInfo
  console: ConsoleEntry[]
  network: NetworkEntry[]
  actions: ActionStep[]
  capturedAt: number
}
