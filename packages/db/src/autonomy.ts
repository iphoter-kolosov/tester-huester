import { repo } from './db'

// The autonomy switch — the single gate that decides whether the manager may WAKE an agent on its own, or stays
// advisory (proposes, the owner applies). This is the one place that answer is computed, so the dashboard, an API
// route, and any future cron script cannot disagree about whether tonight is a night the board acts by itself.
//
// The default is OFF, and it is a HARD default: absence is off, an unrecognised value is off, a missing env is
// off. Autonomy turns on only when something explicit and current says ON. A silent fallback to ON is exactly the
// failure this switch exists to prevent — the owner is asleep, and nothing may act on the live board (money/prod)
// without a value he set on purpose.

export type AutonomyMode = 'on' | 'off'

/** The stored setting the OWNER flips from the dashboard/DB — survives restarts, no redeploy. Primary switch. */
export const AUTONOMY_KEY = 'dispatch.autonomy'
/** The only value that means ON. Anything else stored under the key reads as OFF. */
export const AUTONOMY_ON = 'on'
/** The OPS override env var: set it and it WINS over the stored row, so infra can force a state without DB access. */
export const AUTONOMY_ENV = 'TH_AUTONOMY'

/** The env values that count as an explicit ON. Every other non-empty value is an explicit OFF (never ignored). */
const ENV_ON = new Set(['on', '1', 'true', 'yes'])

/**
 * Resolve the effective mode. Order: an explicit env override wins (ops kill/enable switch); otherwise the stored
 * row; otherwise OFF. `getMeta` is injectable so this is testable without a database — the web/cron caller passes
 * `repo.getMeta`, a test passes a stub.
 *
 * @param getMeta reader for the stored setting; defaults to the live repo.
 * @param env process env to read the override from; defaults to process.env.
 */
export function resolveAutonomy(
  getMeta: (key: string) => string | null = repo.getMeta.bind(repo),
  env: Record<string, string | undefined> = process.env,
): AutonomyMode {
  const override = env[AUTONOMY_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    // Present-and-explicit: ops has spoken, and even "off" here must beat a stored "on".
    return ENV_ON.has(override.trim().toLowerCase()) ? 'on' : 'off'
  }
  return getMeta(AUTONOMY_KEY) === AUTONOMY_ON ? 'on' : 'off'
}
