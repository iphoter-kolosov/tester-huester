import type { EnvInfo } from './types.js'

// Best-effort browser fingerprint. Everything is optional-chained so it degrades to a bare record if a
// field is unavailable (private mode, older engines). Pure read of globals — no side effects.
export function captureEnv(win: (Window & typeof globalThis) | undefined = globalThisWindow()): EnvInfo {
  const nav = win?.navigator as (Navigator & { connection?: { effectiveType?: string }; userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] } }) | undefined
  const uaData = nav?.userAgentData
  const brand = uaData?.brands?.filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`)[0]
  let timezone: string | undefined
  try {
    timezone = win?.Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone
  } catch {
    timezone = undefined
  }
  return {
    url: win?.location?.href ?? '',
    userAgent: nav?.userAgent ?? '',
    browser: brand,
    os: uaData?.platform,
    viewport: win ? `${win.innerWidth}x${win.innerHeight}` : '',
    dpr: win?.devicePixelRatio ?? 1,
    timezone,
    languages: nav?.languages ? Array.from(nav.languages) : undefined,
    connection: nav?.connection?.effectiveType,
  }
}

function globalThisWindow(): (Window & typeof globalThis) | undefined {
  return typeof window !== 'undefined' ? window : undefined
}
