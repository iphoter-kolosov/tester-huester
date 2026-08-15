// The public address of THIS board, as it must appear in `TH_COLLECTOR=` inside a connection snippet.
//
// One author, because there were two and one was wrong: /api/onboarding derived it from `new URL(req.url).origin`,
// which in a Next route handler is the address the process listens on and NOT the address the caller used — a
// request to 127.0.0.1:4990 with `Host: qa.ihor.work` still answered `http://localhost:4990`. Every deployment
// behind a proxy would therefore have handed each agent a snippet pointing at the collector's own loopback, and
// the failure surfaces at the agent's first call, far from here.

const FORWARDED_HOST = 'x-forwarded-host'
const FORWARDED_PROTO = 'x-forwarded-proto'
const LOCAL_HOSTS = ['localhost', '127.0.0.1']

/** No host in the request means the address genuinely is not knowable here. A placeholder the reader must replace
 *  beats a plausible host that is right on this deployment and silently wrong on the next. */
export const COLLECTOR_UNKNOWN = '<https address of this board>'

/** Behind several proxies these headers arrive as a comma-separated list; the first entry is the outermost. */
const first = (v: string | null): string => (v ? v.split(',')[0]!.trim() : '')

export function collectorBase(h: Headers): string {
  const host = first(h.get(FORWARDED_HOST)) || first(h.get('host'))
  if (!host) return COLLECTOR_UNKNOWN
  const proto = first(h.get(FORWARDED_PROTO)) || (LOCAL_HOSTS.some((l) => host.startsWith(l)) ? 'http' : 'https')
  return `${proto}://${host}`
}
