// The extension is installed unpacked from a folder on the tester's machine, so a new build is just new files in
// that folder — but Chrome keeps running the old code until somebody presses ⟳ on chrome://extensions. That press
// was the one step left in every update (30.10.2026: «убери у владельца навсегда»). The background worker watches
// the manifest ON DISK (an unpacked extension serves its files straight from the folder) and reloads itself when
// the folder holds a different version.

/** Seconds between checks — a minute is fast enough for "I just put the new files there" and costs nothing. */
export const CHECK_MINUTES = 1
export const ALARM = 'th-selfupdate'

/**
 * Reload only on a version that is different from the running one AND was already seen on the previous check:
 * the folder is replaced file by file, and a reload in the middle of that would load half a build.
 */
export function shouldReload(running: string, onDisk: string | null, seenBefore: string | null): boolean {
  if (!onDisk || onDisk === running) return false
  return onDisk === seenBefore
}

/** The version in manifest.json as it is on disk now, or null if it cannot be read (mid-copy, store install). */
export async function diskVersion(): Promise<string | null> {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })
    if (!r.ok) return null
    const v = ((await r.json()) as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch (e) {
    // Half-written manifest during the copy: not an error worth more than a line — the next check will see it whole.
    console.warn('[th] self-update: manifest on disk unreadable', e)
    return null
  }
}
