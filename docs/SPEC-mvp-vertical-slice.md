# tester-huester — MVP (vertical slice)

**Date:** 2026-07-18
**Status:** design approved (Ihor), implementing the vertical slice

## Vision

A **browser extension** that, when enabled, lets a tester capture a note (screenshot + drawing + text)
on **any** website — no cooperation from the target site needed. A backend collects every report into a
database with a **dashboard**, reachable three ways: by hand (dashboard UI), by **API**, and by **MCP** —
so the client's AI agents pull reports, read the screenshot + note, and act on them. It closes the loop:
tester → extension → DB → MCP → AI agent fixes it. Self-hosted "Marker.io / BugHerd, but MCP-native".

Origin: extracted and re-architected from the QA/feedback system built inside eRENTAL (the 🐞 widget +
`/qa` board + tester management), now a standalone product.

## MVP — Definition of Done

A tester installs the extension, opens ANY site, hits a shortcut, the extension screenshots the visible
tab (`chrome.tabs.captureVisibleTab` — no per-shot permission prompt), the tester draws + types a note and
hits Send. The report lands in Postgres, is visible in a minimal dashboard list (thumbnail, note, page URL,
time, status), and Claude Code — over MCP — runs `list_reports` / `get_report` and sees that exact
screenshot + note. The whole loop, proven with the thinnest possible thread.

## Architecture — monorepo (pnpm + Turborepo, TypeScript throughout)

```
tester-huester/
├─ packages/core   — capture + annotate (draw/crop/undo) + serialization; framework-agnostic TS
├─ packages/db     — Drizzle schema + client; shared by web and mcp
├─ apps/extension  — MV3 extension (WXT + React)
├─ apps/web        — Next.js (App Router): POST /api/ingest + dashboard
└─ apps/mcp        — MCP server (stdio) reading packages/db
```

## Data model (MVP — minimal)

- **projects**: `id` (uuid), `name` (text), `ingest_key` (text, unique, indexed), `created_at`.
- **reports**: `id` (uuid), `project_id` (fk), `note` (text), `screenshot_url` (text),
  `page_url` (text), `viewport` (text), `user_agent` (text), `reporter` (text, nullable),
  `status` (text: `new` | `triaged` | `fixed` | `wontfix`, default `new`), `created_at`.

Testers/codes, the collaborative task board, and multi-project management come in v2 — the schema stays
additive.

## Components — MVP scope

1. **packages/core** — port the capture/annotate/crop/serialize logic out of eRENTAL's `FeedbackWidget`
   into a clean TS module with no React/store/i18n dependency. The extension (and later any client) uses it.
   MVP wires: load an image, draw one stroke color, type a note, export a JPEG dataURL. (Crop/undo/multicolor
   exist in the module but the extension UI wires them in v2.)
2. **apps/extension (WXT, MV3)** — a toolbar action / keyboard shortcut opens an in-page overlay. Background
   script does `captureVisibleTab`; content script shows the shot + a one-color draw layer + a note field +
   Send. The popup holds config: collector URL + project ingest key. Send → `POST {collectorUrl}/api/ingest`.
3. **apps/web — /api/ingest** — validate the ingest key against `projects`; store the screenshot via a
   `Storage` interface (dev: local `uploads/` served statically; prod: Cloudflare R2); insert a `reports`
   row; return `{ ok, id }`. Fail loudly on a bad key (401) or oversized payload (413).
4. **apps/web — dashboard** — one page behind a single shared password (signed cookie). Lists reports
   newest-first: thumbnail, note, page URL, relative time, a status `<select>`. Click a row → full
   screenshot + metadata. No multi-project UI yet.
5. **apps/mcp (stdio)** — tools: `list_reports({ projectId?, status?, limit? })`, `get_report({ id })`,
   `set_status({ id, status })`. Reads/writes `packages/db`. Registered with Claude Code locally so an agent
   can pull and triage reports.

## Stack decisions (fixed)

TypeScript everywhere · **WXT** for the MV3 extension (Chrome+Firefox) · **Next.js App Router** for
API+dashboard · **Postgres + Drizzle ORM** · screenshots in **Cloudflare R2** (dev: local disk, behind a
`Storage` interface) · **MCP over stdio** now (HTTP/SSE later) · hosting like eRENTAL (Oracle VPS +
Cloudflare Tunnel) or Vercel.

Backend is custom (Next + Drizzle), not Payload — the product wants a tailored triage UX and a clean
API/MCP surface; Payload's generic admin would fight that.

## Explicitly OUT of the MVP (v2+)

Crop / multi-color / undo wired into the extension UI · testers + personal codes · the collaborative `/qa`
task board · Chrome Web Store publish · webhooks · multi-project management UI · real dashboard auth (SSO) ·
HTTP/SSE MCP transport · i18n.

## Build order (the vertical thread)

1. Monorepo skeleton (pnpm workspace, turbo, base tsconfig).
2. `packages/db` — Drizzle schema + migration + client; seed one project with an ingest key.
3. `apps/web` — `/api/ingest` + storage interface + dashboard list/detail + shared-password gate.
4. `apps/mcp` — the three tools; connect to Claude Code and read a report end-to-end.
5. `packages/core` — extract capture/annotate from the eRENTAL widget.
6. `apps/extension` — overlay + capture + send; load unpacked, capture on a real third-party site.
7. Demo the full loop; then plan v2 (testers, board, crop UI, R2 prod, publish).
