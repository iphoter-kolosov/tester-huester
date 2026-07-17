# tester-huester

A browser extension that captures a QA note (screenshot + drawing + text) on **any** website, and a
backend that collects every report into a database with a **dashboard** — reachable by hand, by **API**,
and by **MCP**, so AI agents pull reports and act on them. Self-hosted, MCP-native "Marker.io / BugHerd".

Extracted and re-architected from the QA/feedback system built inside eRENTAL.

## Status (MVP vertical slice)

| Piece | State |
|---|---|
| `packages/db` — SQLite (Node 24 built-in `node:sqlite`), zero deps | ✅ working |
| `apps/web` — `POST /api/ingest` + dashboard (list / detail / status) | ✅ working |
| `apps/mcp` — MCP server: `list_reports`, `get_report`, `set_status` | ✅ working (smoke-tested) |
| `packages/core` — capture/annotate/crop, extracted from the eRENTAL widget | ⏳ next |
| `apps/extension` — MV3 extension (WXT) that captures on any site | ⏳ next |

The backend loop is proven end-to-end: an any-origin `POST /api/ingest` lands in SQLite, shows on the
dashboard, and is readable over MCP by an agent.

## Run it

```bash
pnpm install
pnpm --filter @th/db seed        # creates th.db + a Demo project (ingest key: th_demo_key_0001)
pnpm --filter @th/web dev        # dashboard + API at http://localhost:4319
pnpm --filter @th/mcp smoke      # drive the MCP server like an agent would
```

Send a test report:

```bash
curl -X POST http://localhost:4319/api/ingest -H 'content-type: application/json' \
  -d '{"ingestKey":"th_demo_key_0001","note":"hello","pageUrl":"https://example.com","screenshot":"data:image/png;base64,..."}'
```

## Stack

pnpm + Turborepo · TypeScript · Next.js (App Router) for API + dashboard · `node:sqlite` for dev
(swap to Postgres for prod) · MCP over stdio · WXT for the extension (coming).

See `docs/SPEC-mvp-vertical-slice.md` for the design.
