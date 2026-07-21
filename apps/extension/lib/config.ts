// Where reports go + which project they belong to. Defaults make it work out of the box against local dev.
export type Config = { collectorUrl: string; ingestKey: string; recordReplay: boolean }

// Build-time collector URL: a production build (VITE_TH_COLLECTOR set) points at the VPS with no manual popup
// setup; local dev falls back to localhost. Vite statically inlines import.meta.env at build, so this is a
// compile-time constant in the bundle. A per-user popup override (chrome.storage) still wins at runtime.
const ENV_COLLECTOR =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TH_COLLECTOR) ||
  (typeof process !== 'undefined' && process.env?.VITE_TH_COLLECTOR) ||
  ''

export const DEFAULTS: Config = {
  collectorUrl: ENV_COLLECTOR || 'http://localhost:4319',
  ingestKey: 'th_demo_key_0001',
  recordReplay: true, // continuously buffer the last ~2 min of DOM replay (mask-by-default); opt-out in the popup
}

export async function getConfig(): Promise<Config> {
  const c = await chrome.storage.local.get(['collectorUrl', 'ingestKey', 'recordReplay'])
  return {
    collectorUrl: (c.collectorUrl as string) || DEFAULTS.collectorUrl,
    ingestKey: (c.ingestKey as string) || DEFAULTS.ingestKey,
    recordReplay: c.recordReplay === undefined ? DEFAULTS.recordReplay : Boolean(c.recordReplay),
  }
}

export async function setConfig(c: Partial<Config>): Promise<void> {
  await chrome.storage.local.set(c)
}
