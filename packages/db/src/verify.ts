// The verification contract: an agent that claims a ticket is done must hand over a CHECK, not a word.
//
// Why this is enforced in code rather than asked for in a prompt: "fixed" with nothing behind it costs the
// reporter a hunt — which page, which state, what am I even looking for. A claim that cannot be checked in one
// click is not a report, it's a promise. So the API refuses the status change unless the check comes with it.
//
// Rules:
//   • fixed   → comment REQUIRED (what was wrong / what changed) + verifyUrl REQUIRED (absolute http(s))
//   • wontfix → comment REQUIRED (why it is declined); a link is optional
//   • triaged/new → nothing required; picking a ticket up is not a claim
//   • verifySteps are optional everywhere but expected whenever opening the link doesn't show it by itself

export type Verification = { body: string; verifyUrl: string | null; verifySteps: string[] | null }
export type VerifyError = { error: string; message: string }

const MAX_BODY = 4000
const MAX_STEPS = 12
const MAX_STEP_LEN = 300

/** Absolute http(s) only: the link has to work when pasted anywhere, including from a phone. */
export function normalizeVerifyUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return u.toString().slice(0, 2000)
}

export function normalizeSteps(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = v
    .map((s) => (typeof s === 'string' ? s.trim().slice(0, MAX_STEP_LEN) : ''))
    .filter(Boolean)
    .slice(0, MAX_STEPS)
  return out.length ? out : null
}

/**
 * Validate an agent's status change. `pageUrl` is the ticket's own page — quoted back in the error so the agent
 * has a concrete link to use instead of guessing what we want.
 */
export function checkAgentStatusClaim(
  status: string,
  body: Record<string, unknown>,
  pageUrl: string | null,
): { ok: true; claim: Verification | null } | { ok: false; err: VerifyError } {
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, MAX_BODY) : ''
  const verifyUrl = normalizeVerifyUrl(body.verifyUrl)
  const verifySteps = normalizeSteps(body.verifySteps)

  if (status === 'fixed' || status === 'wontfix') {
    if (!comment) {
      return {
        ok: false,
        err: {
          error: 'comment_required',
          message:
            status === 'fixed'
              ? 'Status \'fixed\' needs a "comment" saying what was actually wrong and what changed, including the commit/PR.'
              : 'Status \'wontfix\' needs a "comment" explaining why the ticket is declined — the reporter has to be able to disagree with a reason.',
        },
      }
    }
  }
  if (status === 'fixed' && !verifyUrl) {
    const suggestion = normalizeVerifyUrl(pageUrl)
    return {
      ok: false,
      err: {
        error: 'verify_url_required',
        message:
          `Status 'fixed' needs "verifyUrl" — an absolute http(s) link the reporter can click to see the fix. ` +
          (suggestion
            ? `This ticket was captured on ${suggestion} — use that, or a deeper link that lands directly on the fixed screen. `
            : '') +
          `Add "verifySteps" (a short array of steps) whenever opening the link is not enough on its own.`,
      },
    }
  }
  if (!comment && !verifyUrl && !verifySteps) return { ok: true, claim: null }
  return { ok: true, claim: { body: comment, verifyUrl, verifySteps } }
}
