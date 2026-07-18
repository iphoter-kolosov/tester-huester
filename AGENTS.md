# AGENTS.md — read me first

Note for any AI agent (or human) picking up work in this repo. Skim this before proposing a plan.

## What this project is

`tester-huester` — a self-hosted, MCP-native visual QA tool: a browser extension captures a screenshot +
annotation + note on **any** site, a backend collects reports into a DB with a dashboard, and an MCP
server lets AI agents pull and triage those reports. Think "self-hosted Marker.io / BugHerd, MCP-native."
Extracted from the QA/feedback system built inside eRENTAL.

- **Design:** `docs/SPEC-mvp-vertical-slice.md`
- **How it stands vs. the market (read before pitching a "differentiator"):**
  `docs/COMPETITIVE-LANDSCAPE.md`
- **How to run it:** `README.md`

## Orient before you build — two things worth internalizing

1. **"Self-hosted + MCP-native" is NOT a moat.** Competitors already ship it — Faster Fixes is
   open-source + self-hostable + MCP; BugPin is self-host + SQLite + Docker; Marker.io and BugHerd both
   have MCP servers. Treat it as table stakes. See `docs/COMPETITIVE-LANDSCAPE.md`.
2. **Agent-facing context — was our biggest gap, now largely closed.** We used to send only `screenshot + note + pageUrl + viewport + userAgent` — a picture with no fixable context. That gap is now shipped: every report carries a **ReproBundle** captured in the page's MAIN world and PII-masked before it leaves the browser — a **per-interacted-element DOM selector** (CSS via `@medv/finder` + role + accessible name + visible text + testid), **console logs** (incl. uncaught errors / unhandled rejections), **network-request metadata** (fetch + XHR: method, redacted URL, status, timing — no bodies, no headers), and an **action trail** ("the hands": click/input/change/submit/whitelisted keys) with numbered repro steps an agent reads over MCP. This reaches parity with the leaders on the axis that lets an agent *act* instead of guess. Remaining frontier (NOT built, don't claim it): a **full DOM / accessibility-tree snapshot** (we capture selectors for interacted elements only, never a page-wide HTML/AX dump, no outerHTML/styles/coordinates), **request/response bodies & headers**, cross-origin/iframe capture, full stack traces, and **continuous session replay** (only one still screenshot + bounded rings, no DOM timeline). A `chrome.debugger` "deep mode" is noted as future work. If you touch the extension, that snapshot/replay tier is the next leverage point.

## Repo facts (so you don't get surprised)

- **Monorepo:** pnpm + Turborepo. `packages/core` (annotator, framework-agnostic), `packages/db`,
  `apps/web` (Next.js API + dashboard), `apps/mcp` (stdio MCP), `apps/extension` (WXT, MV3).
- **DB is raw `node:sqlite`** in `packages/db/src/db.ts` (zero deps). Despite the SPEC mentioning
  Drizzle/Postgres, **Drizzle is not used** — `packages/db/src/schema.ts` and `client.ts` are empty
  stubs. Columns map 1:1 to an eventual Postgres schema.
- **Known gaps in the current MVP** (don't assume these are done):
  - The dashboard and `PATCH /api/reports/[id]` have **no auth**, though the SPEC/README promise a shared-password gate. There is no `middleware.ts` and no password/session check anywhere. Blocker before any public deploy. **(still open)**
  - `POST /api/ingest` **payload-size handling is only partial.** A 512 KB cap exists on the *sanitized context bundle*, but it merely **drops** the context (returns `null`) rather than returning **413** — the report is still created. The screenshot and the overall `req.json()` body are **unbounded** (no `bodySizeLimit`). SPEC wants a real 413 on oversized. **(still open)**
  - `apps/web/lib/storage.ts` writes to `public/uploads` (an `UPLOAD_DIR` env override sets the *write* dir only). Next won't **serve** runtime-written files there in production and no route/rewrite/R2 serves the bytes, so dashboard `img src="/uploads/..."` will 404 in prod. **(still open)**
  - Capture blind spots (by design, not bugs — but agents will ask): no full DOM/AX snapshot (interacted-element selectors only), no request/response bodies or headers, no cross-origin/iframe capture, no full stack traces, no session replay. See orientation point #2.

## Working agreement

- Develop on a feature branch, keep docs (`README.md`, this file, `docs/`) in sync with code changes.
- Match the existing code's style, comment density, and idioms — the codebase explains *why*, not *what*.
- If you resolve a "known gap" above, update this file so the next agent isn't misled.
