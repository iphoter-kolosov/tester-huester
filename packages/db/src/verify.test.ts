// Contract tests for the "closing a ticket requires evidence" rule. Two of these exist because an adversarial
// review found the defects: an over-long URL used to be silently truncated (storing a broken link as the very
// artefact the contract guarantees), and the local MCP's scope sentinel had a NUL byte in it that made three
// guards unreachable.
import assert from 'node:assert/strict'
import {
  checkAgentStatusClaim,
  checkAssignee,
  checkHandover,
  checkStatusTransition,
  canonicalStatus,
  describeRoster,
  isHandover,
  statusQueryTargets,
  normalizeAgentRole,
  normalizeAgentTitle,
  normalizeIdentity,
  normalizeVerifyUrl,
  normalizeSteps,
  resolveSpeaker,
  MAX_AGENT_ROLE_LEN,
  MAX_AGENT_TITLE_LEN,
  MAX_URL_LEN,
  MAX_IDENTITY_LEN,
  SEEDED_AGENTS,
  STATUS_NEEDS_REVIEW,
  STATUS_TAKEN,
  STATUS_VERIFIED,
  IDENTITY_EXTENSION,
  IDENTITY_OWNER,
  type Actor,
  type RosterEntry,
  type TicketFacts,
} from './verify.ts'

let passed = 0
function t(name: string, fn: () => void) {
  fn()
  passed++
  void name
}

// ── normalizeVerifyUrl ────────────────────────────────────────────────────────────────────────────────────
t('accepts an absolute https link', () => {
  assert.equal(normalizeVerifyUrl('https://erental.ihor.work/staff/orders'), 'https://erental.ihor.work/staff/orders')
})
t('accepts http', () => {
  assert.equal(normalizeVerifyUrl('http://localhost:3000/x'), 'http://localhost:3000/x')
})
t('rejects a relative path — it must work when pasted anywhere', () => {
  assert.equal(normalizeVerifyUrl('/staff/orders'), null)
})
t('rejects dangerous schemes — this becomes an <a href> in the owner dashboard', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox', 'file:///etc/passwd', 'ftp://h/x']) {
    assert.equal(normalizeVerifyUrl(bad), null, bad)
  }
})
t('rejects an over-long URL instead of truncating it', () => {
  const long = 'https://app.example.com/orders/5605?token=' + 'a'.repeat(MAX_URL_LEN) + '&view=timeline'
  assert.ok(long.length > MAX_URL_LEN)
  assert.equal(normalizeVerifyUrl(long), null) // a cut link still parses and still renders — that is the danger
})
t('accepts a URL exactly at the limit', () => {
  const base = 'https://e.com/?q='
  const url = base + 'a'.repeat(MAX_URL_LEN - base.length)
  assert.equal(url.length, MAX_URL_LEN)
  assert.equal(normalizeVerifyUrl(url), url)
})
t('non-strings and blanks are null', () => {
  for (const v of [undefined, null, 42, {}, '', '   ']) assert.equal(normalizeVerifyUrl(v), null)
})

// ── normalizeSteps ────────────────────────────────────────────────────────────────────────────────────────
t('keeps non-empty steps, drops blanks, caps the count', () => {
  assert.deepEqual(normalizeSteps(['a', '  ', 'b']), ['a', 'b'])
  assert.equal(normalizeSteps(Array(30).fill('x'))!.length, 12)
  assert.equal(normalizeSteps([]), null)
  assert.equal(normalizeSteps('not an array'), null)
})

// ── the status contract ───────────────────────────────────────────────────────────────────────────────────
const PAGE = 'https://erental.ihor.work/staff/orders'

t('fixed with nothing → comment required', () => {
  const r = checkAgentStatusClaim('fixed', {}, PAGE)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'comment_required')
})
t('fixed with a comment but no link → verify_url_required, quoting the ticket page', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'done' }, PAGE)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'verify_url_required')
  assert.ok(r.ok === false && r.err.message.includes(PAGE), 'the error should hand the agent a concrete link')
})
t('fixed with a REJECTED link → says the link was bad, not that it was missing', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'done', verifyUrl: 'javascript:alert(1)' }, PAGE)
  assert.equal(r.ok, false)
  // Distinct error: otherwise the agent resends the same broken value forever.
  assert.equal(r.ok === false && r.err.error, 'verify_url_invalid')
})
t('fixed with an over-long link → explains the limit rather than silently cutting', () => {
  const long = 'https://e.com/?t=' + 'a'.repeat(MAX_URL_LEN)
  const r = checkAgentStatusClaim('fixed', { comment: 'done', verifyUrl: long }, PAGE)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'verify_url_invalid')
  assert.ok(r.ok === false && r.err.message.includes(String(MAX_URL_LEN)))
})
t('fixed done properly → passes and carries the claim', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'fixed in a1b2c3d', verifyUrl: PAGE, verifySteps: ['open', 'hover'] }, PAGE)
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.claim?.verifyUrl, PAGE)
  assert.deepEqual(r.ok === true && r.claim?.verifySteps, ['open', 'hover'])
})
t('wontfix needs a reason but no link', () => {
  assert.equal(checkAgentStatusClaim('wontfix', {}, PAGE).ok, false)
  assert.equal(checkAgentStatusClaim('wontfix', { comment: 'by design' }, PAGE).ok, true)
})
t('triaged/new require nothing — picking a ticket up is not a claim', () => {
  for (const s of ['triaged', 'new']) {
    const r = checkAgentStatusClaim(s, {}, PAGE)
    assert.equal(r.ok, true, s)
    assert.equal(r.ok === true && r.claim, null)
  }
})
t('a ticket with no pageUrl still gets a usable message', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'done' }, null)
  assert.equal(r.ok, false)
  assert.ok(r.ok === false && r.err.message.includes('verifyUrl'))
})

// ── identities ────────────────────────────────────────────────────────────────────────────────────────────
t('identities fold to one canonical form, so the filer is never a stranger to their own ticket', () => {
  assert.equal(normalizeIdentity('  Core-Agent '), 'core-agent')
  assert.equal(normalizeIdentity('Photoking   Agents'), 'photoking agents')
  assert.equal(normalizeIdentity('x'.repeat(MAX_IDENTITY_LEN + 20))!.length, MAX_IDENTITY_LEN)
  for (const v of [undefined, null, 42, {}, '', '   ']) assert.equal(normalizeIdentity(v), null)
})

// ── legacy aliases ────────────────────────────────────────────────────────────────────────────────────────
t("an executor's 'fixed' is a claim (needs_review), the owner's 'fixed' is acceptance (verified)", () => {
  assert.equal(canonicalStatus('fixed', 'agent'), STATUS_NEEDS_REVIEW)
  assert.equal(canonicalStatus('fixed', 'owner'), STATUS_VERIFIED)
  assert.equal(canonicalStatus('triaged', 'agent'), STATUS_TAKEN)
  assert.equal(canonicalStatus('triaged', 'owner'), STATUS_TAKEN)
  assert.equal(canonicalStatus('needs_review', 'agent'), STATUS_NEEDS_REVIEW)
  assert.equal(canonicalStatus('nonsense', 'owner'), null)
})
t("a legacy ?status=fixed query still finds work: it means both 'claimed' and 'accepted'", () => {
  assert.deepEqual(statusQueryTargets('fixed'), [STATUS_NEEDS_REVIEW, STATUS_VERIFIED])
  assert.deepEqual(statusQueryTargets('triaged'), [STATUS_TAKEN])
  assert.deepEqual(statusQueryTargets('verified'), [STATUS_VERIFIED])
})

// ── the lifecycle: who may say what ───────────────────────────────────────────────────────────────────────
const FILER = 'filer-agent'
const EXECUTOR = 'executor-agent'
const ticket = (over: Partial<TicketFacts> = {}): TicketFacts => ({ status: STATUS_NEEDS_REVIEW, creator: FILER, takenBy: EXECUTOR, pageUrl: PAGE, ...over })
const asAgent = (identity: string): Actor => ({ kind: 'agent', identity })
const OWNER: Actor = { kind: 'owner', identity: IDENTITY_OWNER }
// A complete work report — the four parts: what was done, where, how to check, what proves it.
const WORK_REPORT = {
  comment: 'the cursor was resolved per project, now per agent',
  verifyUrl: 'https://qa.ihor.work/r/70e17260',
  verifySteps: ['open the ticket', 'set status taken as another agent'],
  evidence: 'npx tsx packages/db/src/verify.test.ts — all tests passed',
}

t('the executor is REFUSED verified, and is told who may and what to do instead', () => {
  const r = checkStatusTransition('verified', {}, ticket(), asAgent(EXECUTOR))
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'not_your_call')
  assert.ok(r.ok === false && r.err.message.includes(FILER), 'the error must name the agent who may close it')
  assert.ok(r.ok === false && r.err.message.includes(STATUS_NEEDS_REVIEW), 'and the status the executor should use instead')
})
t('the executor is refused rejected too — the verdict is the filer\'s, both ways', () => {
  const r = checkStatusTransition('rejected', { comment: 'looks fine to me' }, ticket(), asAgent(EXECUTOR))
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'not_your_call')
})
t('the FILER may accept its own ticket', () => {
  const r = checkStatusTransition('verified', {}, ticket(), asAgent(FILER))
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.status, STATUS_VERIFIED)
})
t('the filer is matched case-insensitively — "Filer-Agent" is not a different agent', () => {
  const r = checkStatusTransition('verified', {}, ticket({ creator: FILER }), asAgent(normalizeIdentity('Filer-Agent')!))
  assert.equal(r.ok, true)
})
t('the OWNER may accept anything, including a ticket filed by someone else', () => {
  const r = checkStatusTransition('verified', {}, ticket(), OWNER)
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.status, STATUS_VERIFIED)
})
t('a ticket with no known filer can only be closed by the owner', () => {
  const anonymous = ticket({ creator: null })
  assert.equal(checkStatusTransition('verified', {}, anonymous, asAgent(EXECUTOR)).ok, false)
  assert.equal(checkStatusTransition('verified', {}, anonymous, OWNER).ok, true)
})
t('rejected demands a reason from everyone — the owner included', () => {
  const noReason = checkStatusTransition('rejected', {}, ticket(), OWNER)
  assert.equal(noReason.ok, false)
  assert.equal(noReason.ok === false && noReason.err.error, 'comment_required')
  assert.equal(checkStatusTransition('rejected', { comment: 'the second screen still shows the old total' }, ticket(), OWNER).ok, true)
})
t('an unknown status is refused with the real list, not a shrug', () => {
  const r = checkStatusTransition('done', {}, ticket(), OWNER)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'bad_status')
  assert.ok(r.ok === false && r.err.message.includes(STATUS_NEEDS_REVIEW))
})

// ── the work report ───────────────────────────────────────────────────────────────────────────────────────
t('needs_review demands all four parts, each refused by name', () => {
  const cases: [keyof typeof WORK_REPORT, string][] = [
    ['comment', 'comment_required'],
    ['verifyUrl', 'verify_url_required'],
    ['verifySteps', 'verify_steps_required'],
    ['evidence', 'evidence_required'],
  ]
  for (const [missing, expected] of cases) {
    const body: Record<string, unknown> = { ...WORK_REPORT }
    delete body[missing]
    const r = checkStatusTransition('needs_review', body, ticket({ status: STATUS_TAKEN }), asAgent(EXECUTOR))
    assert.equal(r.ok, false, `missing ${missing} should be refused`)
    assert.equal(r.ok === false && r.err.error, expected, `missing ${missing}`)
  }
})
t('a complete work report passes and carries all four parts', () => {
  const r = checkStatusTransition('needs_review', WORK_REPORT, ticket({ status: STATUS_TAKEN }), asAgent(EXECUTOR))
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.status, STATUS_NEEDS_REVIEW)
  assert.equal(r.ok === true && r.claim?.evidence, WORK_REPORT.evidence)
  assert.deepEqual(r.ok === true && r.claim?.verifySteps, WORK_REPORT.verifySteps)
})
t('a legacy fixed keeps its OLD contract — comment + link — so deployed agents do not start failing', () => {
  const r = checkStatusTransition('fixed', { comment: 'fixed in a1b2c3d', verifyUrl: PAGE }, ticket({ status: STATUS_TAKEN }), asAgent(EXECUTOR))
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.status, STATUS_NEEDS_REVIEW, 'but it lands in the lifecycle, not in a dead end')
})
t('taking a ticket costs nothing and records WHO holds it', () => {
  const r = checkStatusTransition('taken', {}, ticket({ status: 'new', takenBy: null }), asAgent(EXECUTOR))
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.takenBy, EXECUTOR)
})
t('finishing a ticket nobody claimed stamps the finisher as holder, so a rejection has somewhere to go', () => {
  const r = checkStatusTransition('needs_review', WORK_REPORT, ticket({ status: 'new', takenBy: null }), asAgent(EXECUTOR))
  assert.equal(r.ok === true && r.takenBy, EXECUTOR)
})
t('a ticket already held by another agent cannot be finished by a second one — held_by_other, not a silent parallel report', () => {
  const r = checkStatusTransition('needs_review', WORK_REPORT, ticket({ status: STATUS_TAKEN, takenBy: 'someone-else' }), asAgent(EXECUTOR))
  assert.equal(!r.ok && r.err.error, 'held_by_other')
})
t('the owner still closes a ticket in one click — no work report demanded of the board owner', () => {
  const r = checkStatusTransition('fixed', {}, ticket(), OWNER)
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.status, STATUS_VERIFIED)
  assert.equal(r.ok === true && r.claim, null)
})

// ── the roster: who exists, and who may be told they exist ────────────────────────────────────────────────
const BOARD_NAME = 'photoking agents' // a PROJECT name — the exact string that used to get registered as an agent

const roster: RosterEntry[] = [
  { handle: 'mcp-core', title: 'MCP-ядро', role: 'Держит контракт MCP и схему базы.', active: true },
  { handle: 'dash-ui', title: 'Дашборд', role: 'Делает экраны владельца.', active: true },
  { handle: 'old-runner', title: 'Прежний исполнитель', role: 'Выведен из строя 12.08.', active: false },
]

t('an identity nobody declared is attributed to the board but NEVER registered under its name', () => {
  const inferred = resolveSpeaker(undefined, BOARD_NAME)
  // Attribution is unchanged — a row still says where it came from.
  assert.equal(inferred.identity, BOARD_NAME)
  // …but the board name must not enter the roster: two agents sharing it would merge into one voice.
  assert.equal(inferred.rosterHandle, null)
  for (const nothing of [null, '', '   ', 42, {}]) {
    assert.equal(resolveSpeaker(nothing, BOARD_NAME).rosterHandle, null, String(nothing))
  }
})
t('a DECLARED identity is both attributed and registered, canonicalised the same way as everywhere else', () => {
  const declared = resolveSpeaker('  MCP-Core ', BOARD_NAME)
  assert.equal(declared.identity, 'mcp-core')
  assert.equal(declared.rosterHandle, 'mcp-core')
})

t('an unknown assignee is refused, and the refusal carries the roster with the roles', () => {
  const r = checkAssignee('mpc-core', roster) // a plausible typo, which is the point
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'unknown_assignee')
  const msg = r.ok === false ? r.err.message : ''
  for (const e of roster.filter((x) => x.active)) {
    assert.ok(msg.includes(e.handle), `the error must list ${e.handle}`)
    assert.ok(msg.includes(e.role), `and say what ${e.handle} is responsible for`)
  }
  // Offering a retired handle here would only earn the caller a second refusal for taking the suggestion…
  assert.ok(!msg.includes('old-runner'))
  // …but it is counted, so nobody concludes it was deleted.
  assert.ok(msg.includes('1 more on the roster are retired'), msg)
})
t('a known active assignee is accepted, case and spacing folded', () => {
  const r = checkAssignee('  Dash-UI ', roster)
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.assignee, 'dash-ui')
})
t('null and "" clear the address — a ticket may go back to being unaddressed', () => {
  for (const clear of [null, '']) {
    const r = checkAssignee(clear, roster)
    assert.equal(r.ok, true, String(clear))
    assert.equal(r.ok === true && r.assignee, null)
  }
})
t('a retired agent is refused separately, and the answer lists only the ones still taking work', () => {
  const r = checkAssignee('old-runner', roster)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'assignee_inactive')
  const msg = r.ok === false ? r.err.message : ''
  assert.ok(msg.includes('mcp-core'))
  assert.ok(!msg.includes('Выведен из строя'), 'the inactive one must not be offered again in the same breath')
})
t('a board name is not an agent: addressing work to it is refused like any other stranger', () => {
  const r = checkAssignee(BOARD_NAME, roster)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'unknown_assignee')
})
t('an assignee that normalises to nothing is refused as malformed, not silently cleared', () => {
  const r = checkAssignee('   ', roster)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'bad_assignee')
})
t('an empty roster says so, and says how an agent gets onto it', () => {
  const r = checkAssignee('anyone', [])
  assert.equal(r.ok, false)
  assert.ok(r.ok === false && r.err.message.includes('/api/agents'))
})
t('an agent that has not described itself is listed with a nudge rather than a blank', () => {
  const bare: RosterEntry[] = [{ handle: 'newcomer', title: '', role: '', active: true }]
  const text = describeRoster(bare)
  assert.ok(text.includes('newcomer'))
  assert.ok(text.includes('/api/agents'), 'the reader must learn how that entry gets filled in')
})

t('the owner and the extension are seeded described, so no thread shows a bare handle', () => {
  const handles = SEEDED_AGENTS.map((a) => a.handle)
  assert.deepEqual(handles, [IDENTITY_OWNER, IDENTITY_EXTENSION])
  for (const a of SEEDED_AGENTS) assert.ok(a.role.length > 40, `${a.handle} needs a real role, not a label`)
  // The extension is a capture channel, not somebody you can hand work to.
  assert.equal(SEEDED_AGENTS.find((a) => a.handle === IDENTITY_EXTENSION)!.active, false)
  assert.equal(checkAssignee(IDENTITY_EXTENSION, SEEDED_AGENTS as RosterEntry[]).ok, false)
  assert.equal(checkAssignee(IDENTITY_OWNER, SEEDED_AGENTS as RosterEntry[]).ok, true)
})

t('a description is trimmed and capped; a role cannot break the one-line-per-agent listing', () => {
  assert.equal(normalizeAgentTitle('  MCP   ядро '), 'MCP ядро')
  assert.equal(normalizeAgentTitle('x'.repeat(MAX_AGENT_TITLE_LEN + 50))!.length, MAX_AGENT_TITLE_LEN)
  assert.equal(normalizeAgentRole('x'.repeat(MAX_AGENT_ROLE_LEN + 50))!.length, MAX_AGENT_ROLE_LEN)
  assert.equal(normalizeAgentRole('держит контракт\nи схему'), 'держит контракти схему')
  for (const v of [undefined, null, 42, '', '   ']) {
    assert.equal(normalizeAgentTitle(v), null)
    assert.equal(normalizeAgentRole(v), null)
  }
})

// ── handing work over requires a declared role ────────────────────────────────────────────────────────────
// The rule and its boundary weigh the same: an agent that cannot file work for others must still be able to do
// work, or this gate costs the board more than the nameless filers it refuses.
const NAMELESS = 'newcomer' // on the roster by having acted, described by nobody — the state touchAgent creates
const rosterWithNameless: RosterEntry[] = [...roster, { handle: NAMELESS, title: 'Новичок', role: '', active: true }]

t('an agent with no role may not hand work to another agent, and is told the exact call that fixes it', () => {
  const r = checkHandover(NAMELESS, 'mcp-core', rosterWithNameless)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'role_required')
  const msg = r.ok === false ? r.err.message : ''
  assert.match(msg, /register_agent/, 'the refusal names the call that fixes it')
  assert.match(msg, /title/, 'and both fields it takes')
  assert.match(msg, /role/)
  assert.ok(msg.includes('does not touch the dashboard'), 'and shows what a usable role reads like')
  assert.ok(msg.includes('mcp-core'), 'and names who was left without a filer it can look up')
})
t('a title is not a role: the entry is described and still refused', () => {
  const titled: RosterEntry[] = [{ handle: NAMELESS, title: 'Новичок', role: '', active: true }]
  const r = checkHandover(NAMELESS, 'mcp-core', [...titled, ...roster])
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'role_required')
  assert.ok(r.ok === false && r.err.message.includes('Новичок'), 'the title it does have is quoted, so it sees which entry is meant')
})
t('an agent that IS on the roster with a role hands work over freely', () => {
  assert.equal(checkHandover('mcp-core', 'dash-ui', roster).ok, true)
})
t('an identity nobody declared has no entry at all, and is told to declare one before registering', () => {
  const r = checkHandover(BOARD_NAME, 'mcp-core', roster)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'role_required')
  assert.match(r.ok === false ? r.err.message : '', /TH_AGENT=<your-handle>/, 'the fallback needs a NAME first, not a role')
})
t('every refusal says what is still allowed — an agent must not read this as being locked out', () => {
  for (const who of [NAMELESS, BOARD_NAME]) {
    const r = checkHandover(who, 'mcp-core', rosterWithNameless)
    const msg = r.ok === false ? r.err.message : ''
    for (const allowed of ['taking a ticket', 'commenting', 'work report']) {
      assert.ok(msg.includes(allowed), `${who}: the refusal must say "${allowed}" still works`)
    }
  }
})
t('letting a ticket go, and taking one for yourself, are not handovers', () => {
  assert.equal(checkHandover(NAMELESS, null, rosterWithNameless).ok, true, 'clearing an address hands work to nobody')
  assert.equal(checkHandover(NAMELESS, NAMELESS, rosterWithNameless).ok, true, 'nobody is left reporting to a stranger')
  assert.equal(isHandover(null), false)
  assert.equal(isHandover(''), false)
  assert.equal(isHandover('mcp-core'), true)
})
t('the work itself is untouched by a missing role: take a ticket, report on it, decline it', () => {
  // Structural, and that is the point — the status contract never consults the roster, so no roleless agent can
  // be stopped from working by this gate.
  assert.equal(checkStatusTransition(STATUS_TAKEN, {}, ticket(), asAgent(NAMELESS)).ok, true)
  assert.equal(checkStatusTransition(STATUS_NEEDS_REVIEW, WORK_REPORT, ticket({ status: STATUS_TAKEN, takenBy: NAMELESS }), asAgent(NAMELESS)).ok, true)
  assert.equal(checkStatusTransition('wontfix', { comment: 'не воспроизводится' }, ticket(), asAgent(NAMELESS)).ok, true)
})

t('один тикет — один исполнитель: чужой взятый тикет второй агент не берёт и не сдаёт; владелец может всё', () => {
  const held = ticket({ status: STATUS_TAKEN, takenBy: 'hub-erental' })
  const r = checkStatusTransition(STATUS_TAKEN, {}, held, asAgent('erental'))
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.err.error, 'held_by_other')
  const r2 = checkStatusTransition(STATUS_NEEDS_REVIEW, WORK_REPORT, held, asAgent('erental'))
  assert.equal(!r2.ok && r2.err.error, 'held_by_other')
  assert.equal(checkStatusTransition(STATUS_NEEDS_REVIEW, WORK_REPORT, held, asAgent('hub-erental')).ok, true)
  assert.equal(checkStatusTransition(STATUS_TAKEN, {}, ticket({ status: 'rejected', takenBy: 'hub-erental' }), asAgent('erental')).ok, true)
  assert.equal(checkStatusTransition(STATUS_TAKEN, {}, held, OWNER).ok, true)
})

console.log(`db/verify: all ${passed} tests passed ✓`)
