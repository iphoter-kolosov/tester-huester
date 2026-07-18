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
2. **Our biggest gap is the context we hand the agent.** We send `screenshot + note + pageUrl + viewport
   + userAgent`. The leaders also capture **DOM selector + console logs + network requests** — the data
   that actually lets an agent *fix* a bug instead of guessing from a picture. If you touch the
   extension, this is the highest-leverage thing to add.

## Repo facts (so you don't get surprised)

- **Monorepo:** pnpm + Turborepo. `packages/core` (annotator, framework-agnostic), `packages/db`,
  `apps/web` (Next.js API + dashboard), `apps/mcp` (stdio MCP), `apps/extension` (WXT, MV3).
- **DB is raw `node:sqlite`** in `packages/db/src/db.ts` (zero deps). Despite the SPEC mentioning
  Drizzle/Postgres, **Drizzle is not used** — `packages/db/src/schema.ts` and `client.ts` are empty
  stubs. Columns map 1:1 to an eventual Postgres schema.
- **Known gaps in the current MVP** (don't assume these are done):
  - The dashboard and `PATCH /api/reports/[id]` have **no auth**, though the SPEC/README promise a
    shared-password gate. Blocker before any public deploy.
  - `POST /api/ingest` has **no payload-size limit** (SPEC wants 413 on oversized).
  - `apps/web/lib/storage.ts` writes to `public/uploads`; Next won't serve runtime-written files there
    in production — needs an explicit route or R2.

## Working agreement

- Develop on a feature branch, keep docs (`README.md`, this file, `docs/`) in sync with code changes.
- Match the existing code's style, comment density, and idioms — the codebase explains *why*, not *what*.
- If you resolve a "known gap" above, update this file so the next agent isn't misled.
