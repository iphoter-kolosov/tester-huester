// The extension is installed unpacked, so the browser never updates it: a fixed bug stays broken on the
// tester's machine until somebody tells them. The board publishes its newest build (GET /api/extension); we ask
// on open and, if we are behind, show "новая версия — скачать" right where the tester already looks.

export type Latest = { version: string; url: string; notes: string[] }

/** true when `latest` is a strictly higher dotted version than `current` ("0.10.0" > "0.9.3"). */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const a = parse(latest), b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

/** The newer release, or null when we are current or the board cannot say (offline, older board). */
export async function newerRelease(collectorUrl: string, current: string): Promise<Latest | null> {
  try {
    const r = await fetch(`${collectorUrl.replace(/\/+$/, '')}/api/extension`, { cache: 'no-store' })
    if (!r.ok) return null
    const j = (await r.json()) as { ok?: boolean; version?: string; url?: string; notes?: string[] }
    if (!j.ok || !j.version || !j.url) return null
    return isNewer(j.version, current) ? { version: j.version, url: j.url, notes: j.notes ?? [] } : null
  } catch (e) {
    // Being offline must not break the overlay; say why in the console for whoever debugs it.
    console.warn('[tester-huester] update check failed', e)
    return null
  }
}
