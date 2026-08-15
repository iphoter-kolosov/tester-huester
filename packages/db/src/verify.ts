// The single module that decides what a status change needs and who is allowed to make it. Every transport
// (REST, MCP, dashboard) calls in here — there must never be a second opinion about what closing a ticket costs.
//
// Why the evidence half is enforced in code rather than asked for in a prompt: "fixed" with nothing behind it
// costs the reporter a hunt — which page, which state, what am I even looking for. A claim that cannot be checked
// in one click is not a report, it's a promise. So the API refuses the status change unless the check comes with it.
//
// Why the authority half exists: the board is now agents working for each other, not one owner reading reports.
// An executor that can mark its own work accepted is an executor grading its own exam. The owner's rule, verbatim:
// "последнее финальное слово по закрытию тикета только за тем агентом, который его ставил (или мной)".
//
// The lifecycle:
//   new           → filed, nobody holds it
//   taken         → an executor picked it up (taken_by says who)
//   needs_review  → the executor finished and is waiting for the FILER to check
//   verified      → the filer (or the owner) checked and accepted — the only terminal "done"
//   rejected      → sent back for rework, with a reason
//   wontfix       → declined, with a reason
//
// Requirements per transition (agents):
//   • taken / new       → nothing; picking a ticket up is not a claim
//   • needs_review      → the WORK REPORT: comment (what was done) + verifyUrl (WHERE) + verifySteps (HOW to
//                         check) + evidence (what PROVES it)
//   • verified          → nothing to prove, but only the filer or the owner may say it
//   • rejected          → comment REQUIRED (the reason to rework), filer or owner only
//   • wontfix           → comment REQUIRED (why it is declined); a link is optional
//
// The owner is exempt from the evidence requirements — that was true before this model and stays true; the
// dashboard has always been able to set a status with one click. The single exception is `rejected`: a rework
// order with no reason is useless to whoever has to act on it, so it is required of everyone.

export type Verification = { body: string; verifyUrl: string | null; verifySteps: string[] | null; evidence: string | null }
export type VerifyError = { error: string; message: string }

const MAX_BODY = 4000
const MAX_STEPS = 12
const MAX_STEP_LEN = 300
const MAX_EVIDENCE = 2000

/** Hard ceiling on a stored link. Over this we REJECT rather than truncate — see below. */
export const MAX_URL_LEN = 2000

// ── identity: who is speaking ───────────────────────────────────────────────────────────────────────────────
//
// An identity is a self-declared handle for one agent or department ('mcp-core', 'photoking-agents', 'owner').
// It is NOT an authentication credential — the project read key authenticates the PROJECT, and every agent
// working that project shares it. So identity says who is acting, and the read key says which board they may
// act on; the ownership rules below are a coordination contract between cooperating agents, not a security
// boundary against a hostile one. Anyone holding the read key could already impersonate anyone on that board.

export const MAX_IDENTITY_LEN = 64
// A regex character class for these would have to carry literal control characters in the source, where they
// are invisible to review; a code-point test says the same thing in plain ASCII.
const PRINTABLE_FLOOR = 32
const DEL_CODE = 127
function stripControlChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (code >= PRINTABLE_FLOOR && code !== DEL_CODE) out += ch
  }
  return out
}
export const IDENTITY_OWNER = 'owner'
/** The source recorded for a capture that arrived through the extension without declaring who filed it. */
export const IDENTITY_EXTENSION = 'extension'

/**
 * Fold an identity to its canonical form: lowercase, single-spaced, no control characters, capped.
 *
 * Case and stray whitespace are folded because the ownership check is an equality test — 'Core' vs 'core' would
 * silently make the filer a stranger to their own ticket. Control characters are stripped for the same reason in
 * reverse: two identities that print identically must not compare as different.
 */
export function normalizeIdentity(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = stripControlChars(v)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_IDENTITY_LEN)
    .trim()
  return s || null
}

/** Both sides must actually exist: an unknown creator is not "everybody's ticket". */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a === b
}

// ── statuses ────────────────────────────────────────────────────────────────────────────────────────────────

export const STATUS_NEW = 'new'
export const STATUS_TAKEN = 'taken'
export const STATUS_NEEDS_REVIEW = 'needs_review'
export const STATUS_VERIFIED = 'verified'
export const STATUS_REJECTED = 'rejected'
export const STATUS_WONTFIX = 'wontfix'

export const STATUSES = [
  STATUS_NEW,
  STATUS_TAKEN,
  STATUS_NEEDS_REVIEW,
  STATUS_VERIFIED,
  STATUS_REJECTED,
  STATUS_WONTFIX,
] as const
export type Status = (typeof STATUSES)[number]

// Live agents and the shipped dashboard still send these two. They are accepted forever, not deprecated with a
// date — the whole point of a board is that a client written six months ago keeps working.
export const LEGACY_STATUS_TRIAGED = 'triaged'
export const LEGACY_STATUS_FIXED = 'fixed'

export type ActorKind = 'owner' | 'agent'
/** `identity` is the canonical handle (see normalizeIdentity); for the owner it is IDENTITY_OWNER. */
export type Actor = { kind: ActorKind; identity: string }

const isStatus = (v: string): v is Status => (STATUSES as readonly string[]).includes(v)

/**
 * Map whatever the caller sent onto the canonical lifecycle. Returns null for anything unrecognised — the caller
 * turns that into a 400 that lists the real ones.
 *
 * `fixed` resolves differently per actor, and that asymmetry is the point: from an executor "fixed" is a CLAIM
 * that still owes the filer a check (→ needs_review), while from the owner — who is the final word by rule —
 * "fixed" is the acceptance itself (→ verified). Mapping the owner's click to needs_review would park the ticket
 * waiting for a review the owner just performed.
 */
export function canonicalStatus(raw: string, actorKind: ActorKind): Status | null {
  const s = (raw || '').trim().toLowerCase()
  if (isStatus(s)) return s
  if (s === LEGACY_STATUS_TRIAGED) return STATUS_TAKEN
  if (s === LEGACY_STATUS_FIXED) return actorKind === 'owner' ? STATUS_VERIFIED : STATUS_NEEDS_REVIEW
  return null
}

/**
 * What a `?status=` FILTER should match. A legacy client asking for `fixed` means "the work is claimed done" —
 * after the lifecycle split that is two rows apart (claimed but unchecked, and accepted), and historical rows
 * migrated into `verified`. Returning both keeps that client's list non-empty instead of silently blank.
 */
export function statusQueryTargets(raw: string): string[] {
  const s = (raw || '').trim().toLowerCase()
  if (s === LEGACY_STATUS_FIXED) return [STATUS_NEEDS_REVIEW, STATUS_VERIFIED]
  if (s === LEGACY_STATUS_TRIAGED) return [STATUS_TAKEN]
  return [s]
}

// Only the filer of the ticket (or the owner) may pronounce on the work — accept it or send it back.
const FILER_ONLY: readonly Status[] = [STATUS_VERIFIED, STATUS_REJECTED]

// ── normalisation of the evidence fields ────────────────────────────────────────────────────────────────────

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

/** What proves the work: a test name and its output, a build line, a screenshot URL — one short string. */
export function normalizeEvidence(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, MAX_EVIDENCE)
  return s || null
}

// ── the decision ────────────────────────────────────────────────────────────────────────────────────────────

/** The ticket as it stands BEFORE the transition — everything the rules need to judge the request. */
export type TicketFacts = {
  status: string
  creator: string | null
  takenBy: string | null
  pageUrl: string | null
}

export type StatusDecision =
  | {
      ok: true
      /** The canonical status to store — already resolved from any legacy alias. */
      status: Status
      /** The work report / reason to post as a comment, or null when the transition carries nothing. */
      claim: Verification | null
      /** Who holds the ticket after this transition; null means "leave taken_by as it is". */
      takenBy: string | null
    }
  | { ok: false; err: VerifyError }

const missingUrlError = (pageUrl: string | null, sent: string, forStatus: string): VerifyError => {
  if (sent) {
    // Distinguish "you didn't send one" from "what you sent was rejected" — an agent that passed a
    // javascript:/ftp:/over-long URL otherwise re-sends the same broken value and loops.
    return {
      error: 'verify_url_invalid',
      message:
        sent.length > MAX_URL_LEN
          ? `"verifyUrl" is ${sent.length} characters — the limit is ${MAX_URL_LEN}. It is rejected rather than truncated, because a cut link still looks valid and would send the reporter to a broken page. Shorten it (drop signed tokens or tracking parameters) and resend.`
          : `"verifyUrl" must be an ABSOLUTE http(s) link (got "${sent.slice(0, 80)}"). Relative paths and other schemes are refused — the reporter opens this from the dashboard and it has to work when pasted anywhere.`,
    }
  }
  const suggestion = normalizeVerifyUrl(pageUrl)
  return {
    error: 'verify_url_required',
    message:
      `Status '${forStatus}' needs "verifyUrl" — an absolute http(s) link showing WHERE the change is: the commit/PR, or the page the reviewer should open. ` +
      (suggestion ? `This ticket was captured on ${suggestion} — use that, or a deeper link that lands directly on the changed screen. ` : '') +
      `Add "verifySteps" (a short array of steps) whenever opening the link is not enough on its own.`,
  }
}

/**
 * Validate one status change: may this actor make it, and did they bring what it costs. Nothing is written by
 * this function — the caller writes only after `ok`, so a refused request leaves the ticket untouched.
 */
export function checkStatusTransition(
  raw: string,
  body: Record<string, unknown>,
  ticket: TicketFacts,
  actor: Actor,
): StatusDecision {
  const status = canonicalStatus(raw, actor.kind)
  if (!status) {
    return {
      ok: false,
      err: {
        error: 'bad_status',
        message: `Unknown status "${String(raw).slice(0, 40)}". Use one of: ${STATUSES.join(', ')} (the older '${LEGACY_STATUS_TRIAGED}' and '${LEGACY_STATUS_FIXED}' are still accepted and map to '${STATUS_TAKEN}' / '${STATUS_NEEDS_REVIEW}').`,
      },
    }
  }

  // Authority first: a caller who may not make this call should be told that, not sent away to assemble a work
  // report it is then refused for anyway.
  if (actor.kind === 'agent' && FILER_ONLY.includes(status) && !sameIdentity(actor.identity, ticket.creator)) {
    return {
      ok: false,
      err: {
        error: 'not_your_call',
        message:
          `Only the agent that FILED this ticket (${ticket.creator ? `"${ticket.creator}"` : 'unknown — it was filed before identities existed, so only the owner can close it'}) or the owner may set '${status}'. ` +
          `You are "${actor.identity || 'unidentified'}". Report your work with status '${STATUS_NEEDS_REVIEW}' and a work report (comment + verifyUrl + verifySteps + evidence); the filer accepts it or sends it back.`,
      },
    }
  }

  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, MAX_BODY) : ''
  const verifyUrl = normalizeVerifyUrl(body.verifyUrl)
  const verifySteps = normalizeSteps(body.verifySteps)
  const evidence = normalizeEvidence(body.evidence)
  const claim = (): Verification | null =>
    !comment && !verifyUrl && !verifySteps && !evidence ? null : { body: comment, verifyUrl, verifySteps, evidence }

  // A rework order with no reason is an insult, not an instruction — required of the owner too.
  if (status === STATUS_REJECTED && !comment) {
    return {
      ok: false,
      err: {
        error: 'comment_required',
        message: `Status '${STATUS_REJECTED}' needs a "comment" saying what is still wrong — that text is the whole instruction the executor gets for the rework.`,
      },
    }
  }

  // Beyond that the owner answers to nobody: one click on the dashboard has always been enough, and this model
  // must not turn the owner's board into a form to fill in.
  if (actor.kind === 'owner') return { ok: true, status, claim: claim(), takenBy: takenByAfter(status, ticket, actor) }

  if (status === STATUS_WONTFIX && !comment) {
    return {
      ok: false,
      err: {
        error: 'comment_required',
        message: `Status '${STATUS_WONTFIX}' needs a "comment" explaining why the ticket is declined — the filer has to be able to disagree with a reason.`,
      },
    }
  }

  if (status === STATUS_NEEDS_REVIEW) {
    // A legacy 'fixed' keeps exactly the contract it had before this model existed (comment + link). Agents
    // deployed today send it, and the brief forbids breaking them; the full four-part work report is demanded of
    // callers that ask for 'needs_review' by name, which is what every updated client sends.
    const legacy = (raw || '').trim().toLowerCase() === LEGACY_STATUS_FIXED
    if (!comment) {
      return {
        ok: false,
        err: {
          error: 'comment_required',
          message: `Status '${status}' needs a "comment" saying WHAT WAS DONE — what was actually wrong and what changed.`,
        },
      }
    }
    if (!verifyUrl) {
      return { ok: false, err: missingUrlError(ticket.pageUrl, typeof body.verifyUrl === 'string' ? body.verifyUrl.trim() : '', status) }
    }
    if (!legacy && !verifySteps) {
      return {
        ok: false,
        err: {
          error: 'verify_steps_required',
          message: `Status '${status}' needs "verifySteps" — an array of short steps saying HOW TO CHECK it, in the order the reviewer should do them. The reviewer is another agent: it cannot guess what "obviously" means.`,
        },
      }
    }
    if (!legacy && !evidence) {
      return {
        ok: false,
        err: {
          error: 'evidence_required',
          message: `Status '${status}' needs "evidence" — what PROVES the work: the test that now passes and its output, the build line, the request/response, or the screenshot URL. "Should work" is not evidence.`,
        },
      }
    }
  }

  return { ok: true, status, claim: claim(), takenBy: takenByAfter(status, ticket, actor) }
}

/**
 * Who holds the ticket after the transition. Taking it is explicit; finishing it also stamps a holder, because a
 * work report from nobody leaves the filer with no one to send the rework back to.
 */
function takenByAfter(status: Status, ticket: TicketFacts, actor: Actor): string | null {
  if (actor.kind !== 'agent' || !actor.identity) return null
  if (status === STATUS_TAKEN) return actor.identity
  if (status === STATUS_NEEDS_REVIEW && !ticket.takenBy) return actor.identity
  return null
}

/**
 * The pre-identity entry point, kept so callers that know nothing about actors keep compiling and behaving as
 * they did: an anonymous agent, no ticket facts but the page URL. It can therefore never reach `verified` or
 * `rejected` — which is the correct answer for a caller that cannot say who it is.
 */
export function checkAgentStatusClaim(
  status: string,
  body: Record<string, unknown>,
  pageUrl: string | null,
): { ok: true; claim: Verification | null } | { ok: false; err: VerifyError } {
  const d = checkStatusTransition(status, body, { status: '', creator: null, takenBy: null, pageUrl }, { kind: 'agent', identity: '' })
  return d.ok ? { ok: true, claim: d.claim } : { ok: false, err: d.err }
}
