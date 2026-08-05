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

/** Hard ceiling on a stored link. Over this we REJECT rather than truncate — see below. */
export const MAX_URL_LEN = 2000

/**
 * Absolute http(s) only: the link has to work when pasted anywhere, including from a phone.
 *
 * Length is a rejection, never a truncation. Cutting a signed deep link at 2000 chars produces a string that
 * still parses as a URL and still renders as a button, so the damage is invisible until the reporter clicks it
 * and lands on a 400 — corrupting the one artefact this whole contract exists to guarantee. Better to refuse
 * loudly and let the agent shorten the link.
 */
export function normalizeVerifyUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > MAX_URL_LEN) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const out = u.toString()
  return out.length > MAX_URL_LEN ? null : out
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
    // Distinguish "you didn't send one" from "what you sent was rejected" — an agent that passed a
    // javascript:/ftp:/over-long URL otherwise re-sends the same broken value and loops.
    const sent = typeof body.verifyUrl === 'string' ? body.verifyUrl.trim() : ''
    if (sent) {
      return {
        ok: false,
        err: {
          error: 'verify_url_invalid',
          message:
            sent.length > MAX_URL_LEN
              ? `"verifyUrl" is ${sent.length} characters — the limit is ${MAX_URL_LEN}. It is rejected rather than truncated, because a cut link still looks valid and would send the reporter to a broken page. Shorten it (drop signed tokens or tracking parameters) and resend.`
              : `"verifyUrl" must be an ABSOLUTE http(s) link (got "${sent.slice(0, 80)}"). Relative paths and other schemes are refused — the reporter opens this from the dashboard and it has to work when pasted anywhere.`,
        },
      }
    }
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
