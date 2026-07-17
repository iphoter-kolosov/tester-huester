// Where reports go + which project they belong to. Defaults make it work out of the box against local dev.
export type Config = { collectorUrl: string; ingestKey: string }

export const DEFAULTS: Config = {
  collectorUrl: 'http://localhost:4319',
  ingestKey: 'th_demo_key_0001',
}

export async function getConfig(): Promise<Config> {
  const c = await chrome.storage.local.get(['collectorUrl', 'ingestKey'])
  return {
    collectorUrl: (c.collectorUrl as string) || DEFAULTS.collectorUrl,
    ingestKey: (c.ingestKey as string) || DEFAULTS.ingestKey,
  }
}

export async function setConfig(c: Partial<Config>): Promise<void> {
  await chrome.storage.local.set(c)
}
