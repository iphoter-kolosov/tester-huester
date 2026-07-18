# tester-huester

A browser extension that captures a QA note (screenshot + drawing + text) on **any** website, and a
backend that collects every report into a database with a **dashboard** — reachable by hand, by **API**,
and by **MCP**, so AI agents pull reports and act on them. Self-hosted, MCP-native "Marker.io / BugHerd".

Extracted and re-architected from the QA/feedback system built inside eRENTAL.

## Status

| Piece | State |
|---|---|
| `packages/core` — `ImageAnnotator` + **repro-capture engine** (env / console / network / actions / selectors / redaction), zero runtime deps | ✅ unit-tested |
| `packages/db` — SQLite (Node 24 built-in `node:sqlite`), zero deps, `context` JSON column | ✅ working |
| `apps/web` — `POST /api/ingest` (+ context) + dashboard with **repro-context tabs** | ✅ working |
| `apps/mcp` — MCP server: `list_reports`, `get_report`, `set_status`, **`get_repro_steps`** | ✅ working (smoke-tested) |
| `apps/extension` — MV3 (WXT): capture any tab → annotate → send, **+ MAIN-world context collector** | ✅ builds + e2e-tested |

The whole loop is proven: the extension screenshots the visible tab, the tester annotates + crops, and —
this is the new part — a MAIN-world collector script snapshots the **repro context** (what the app logged,
what it fetched, and what the user did, with robust selectors, all PII-masked in the browser). The report
posts to `/api/ingest`, lands in SQLite, shows on the dashboard as **Steps / Console / Network / Env** tabs,
and an AI agent can pull a ready-to-replay reproduction over MCP (`get_repro_steps`). Only "load unpacked in
Chrome + capture on a live site" needs a human.

### The repro bundle — "one capture, two consumers"

Every capture records a bounded, self-trimming bundle (the "sensory + motor" layer in `@th/core`):

- **Env** — URL, UA-CH browser/OS, viewport + DPR, timezone, languages, connection.
- **Console** — last 200 log/warn/error lines + uncaught errors + unhandled rejections (patched in the page's
  MAIN world, so it sees the *app's* console, not the extension's).
- **Network** — last 200 fetch/XHR requests: method, url, status, timing (bodies are deliberately not read).
- **Actions** — the last 100 user steps (click / type / submit / key) each with a multi-candidate selector
  (CSS via `@medv/finder` + role / accessible-name / text / `data-testid`) — the trail a human *or an agent*
  replays.
- **Redaction is in the browser, before anything leaves the page**: password/token/card fields are masked,
  `Authorization`/`Cookie` headers and token-shaped strings are scrubbed, sensitive query params stripped.

This is the wedge: it's what paid tools (Marker.io / BugHerd / Usersnap) gate behind $149+ tiers, here free
and self-hosted — and it's MCP-native, so it doubles as the recorded "hands" of a future testing agent.

## Run it

```bash
pnpm install
pnpm --filter @th/db seed        # creates th.db + a Demo project (ingest key: th_demo_key_0001)
pnpm --filter @th/web dev        # dashboard + API at http://localhost:4319
pnpm --filter @th/mcp smoke      # drive the MCP server like an agent would
```

Build + load the extension:

```bash
pnpm --filter @th/extension build   # → apps/extension/.output/chrome-mv3
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `apps/extension/.output/chrome-mv3`. On any site press **Ctrl+Shift+Y** (or click the extension →
📸 Capture). Draw / crop / note → **Send**. It appears on the dashboard and over MCP.
(The popup sets the collector URL + ingest key; defaults point at local dev.)

Send a test report by hand:

```bash
curl -X POST http://localhost:4319/api/ingest -H 'content-type: application/json' \
  -d '{"ingestKey":"th_demo_key_0001","note":"hello","pageUrl":"https://example.com","screenshot":"data:image/png;base64,..."}'
```

## Stack

pnpm + Turborepo · TypeScript · Next.js (App Router) for API + dashboard · `node:sqlite` for dev
(swap to Postgres for prod) · MCP over stdio · WXT for the MV3 extension · `@medv/finder` for selectors.

See `docs/SPEC-mvp-vertical-slice.md` for the design, and
`docs/COMPETITIVE-LANDSCAPE.md` for how this sits vs. existing tools (Faster Fixes, BugPin, Marker.io,
BugHerd) and what that implies for the roadmap.
