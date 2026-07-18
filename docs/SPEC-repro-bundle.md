# SPEC — Repro bundle (core v2: the "hands" of the future agent)

## Goal

Turn a QA note from "a screenshot + a sentence" into a **reproducible** report: what the app logged, what it
requested, what the user did — captured automatically, PII-masked in the browser, and readable both by a
human (dashboard tabs) and by an AI agent (MCP). North star: the trail a tester's hands leave today is the
trail an agent replays tomorrow. **One capture, two consumers.**

## Why this is the wedge

Market research (see project memory): screenshot + note + env is commodity. The genuinely useful context —
**console + network + DOM/selectors** — is paywalled by Marker.io / BugHerd / Usersnap ($149+ tiers), and
none of them is self-hostable. Two lanes are uncontested and we already sit in both: **(1) free +
self-hostable + own-your-data**, and **(2) MCP-native capture → agent**. This feature lands both.

## Architecture

```
 page (MAIN world)                         extension (ISOLATED)             collector (Next)          agent
 ─────────────────                         ────────────────────             ────────────────         ─────
 inpage.content.ts                         content.ts (overlay)             /api/ingest              MCP
  ├ patchConsole ─► consoleRing            hotkey → screenshot                sanitizeContext         get_report
  ├ wrapFetchXhr ─► networkRing            requestBundle() ──postMessage──►   repo.createReport(      get_repro_steps
  └ ActionRecorder ► actionRing            (snapshot BEFORE overlay opens)      {..., context})       ▲
              │                                     │                              │ SQLite `context`  │
              └──── assembleBundle() ◄── TH_COLLECT ┘        buildReport({context})└──────────────────┘
```

- **MAIN world is mandatory** for console + fetch/XHR: an isolated content script gets its own `console`
  and `fetch`, not the page's. `inpage.content.ts` runs at `document_start`, `world:"MAIN"`. It uses **no
  `chrome.*`** (unavailable there) and talks to the overlay only via `window.postMessage`.
- **Snapshot at trigger time.** The overlay requests the bundle the instant the hotkey fires, *before*
  mounting — so the tester's own clicks on our UI never pollute the action trail.
- **Rings** bound memory: console 200 / network 200 / actions 100, trimmed again at assembly (`CAPS`).
- **Selectors are multi-candidate** (`bestSelector`): CSS (`@medv/finder`) + role + accessible-name + text +
  `data-testid`. Exact CSS is brittle; the rest is what survives a redesign and what Playwright/agent
  locators prefer (`getByRole` / `getByText` / `getByTestId`).

## Privacy — mask in the browser, before egress

`redact.ts` runs client-side, in the page, before anything is posted:
- password/token/card/`cc-*` input values → `••••••` (name/id/autocomplete/type heuristics).
- `Authorization` / `Cookie` / `x-api-key` headers → masked; JWT/`sk-`/`gh*_`/`Bearer` token shapes scrubbed
  anywhere in free text (console lines, URLs).
- sensitive/`email`/`user` query params stripped from recorded URLs.
Server (`sanitizeContext` in `/api/ingest`) is defence-in-depth: keeps only known keys, re-caps arrays, drops
bundles over 512 KB. **Never trust the client.**

## Data model

`reports.context` — nullable `text` column holding the JSON `ReproBundle` (`{ env, console[], network[],
actions[], capturedAt }`). Idempotent `ALTER TABLE … ADD COLUMN` migrates existing DBs. Maps 1:1 to a future
Postgres `jsonb`.

## MCP surface

- `get_report` returns the row incl. `context` (raw bundle).
- `get_repro_steps` returns the **agent-ready** shape: numbered human steps from the action trail + a triage
  summary (console errors, failed requests ≥400/0, environment). This is the payoff of consumer #2.

## Known blind spots (documented on purpose)

- MAIN-world fetch/XHR wrap does **not** see Service-Worker traffic, `sendBeacon`, or WebSocket frames, and
  does not read response bodies. A future opt-in "deep mode" on `chrome.debugger`/CDP can fill these (at the
  cost of the scary "extension is debugging this page" banner).
- DOM is captured per-action as selector + (later) element HTML, not a full-page snapshot. Full DOM/AX
  snapshot with stable refs is the Stage-3 step toward an agent that can *drive* the page.

## Verification

- `@th/core` unit tests (`capture.test.ts`): rings, redaction, selector candidates, console format+patch,
  fetch wrap (success/fail), action `toStep`, bundle assembly + caps + repro-step formatting.
- `apps/mcp/src/ctx-e2e.ts`: bundle round-trips through SQLite unchanged **and** through the HTTP ingest
  route + sanitizer.
- Dashboard tabs render (Steps/Console/Network/Env) + list badges; `wxt build` emits a valid MV3 with the
  MAIN-world content script; MCP smoke drives `get_repro_steps`.

## Roadmap (next stages, not in this slice)

- **Stage 2** — rrweb "last 2 min" replay with mask-by-default + an in-dashboard player; action-trail →
  Playwright script (`getByRole/getByText`, Chrome-Recorder / `@puppeteer/replay` format).
- **Stage 3 (the hands)** — AX/DOM snapshot with stable refs → drive the page (synthetic → `chrome.debugger`
  trusted input) → full agent loop on an external Playwright/CDP host.
