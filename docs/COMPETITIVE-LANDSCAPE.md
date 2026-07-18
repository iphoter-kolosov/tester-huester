# tester-huester — Competitive landscape

**Date:** 2026-07-18
**Status:** research snapshot (for agents/collaborators working on this repo)
**Scope:** where `tester-huester` sits vs. existing visual bug-reporting / QA-feedback tools, and what
that implies for what we build next.

> Read this before proposing a "differentiator" or a roadmap. The short version: the category is crowded,
> and our headline pitch — **self-hosted + MCP-native** — is *already shipped by competitors*. It is table
> stakes, not a moat. Our capture is currently **thinner** than the leaders on the one axis that makes
> agent-driven fixing actually work (structured page context). Plan accordingly.

## Market shape (2026)

The category has split into two camps:

1. **Visual feedback for clients** — pin comments on a live site, review workflow:
   Marker.io, BugHerd, Pastel, Userback, Usersnap.
2. **Developer-context capture** — ship a complete debug trace to engineering:
   Jam, BetterBugs, Crosscheck, Disbug.

`tester-huester` aims *between* them: "screenshot + annotation + note → DB → hand it to an AI agent over
MCP." That in-between position is real, but every serious player has now added an MCP/AI-agent surface.

## Direct competitors

| Tool | Self-host / OSS | MCP server | Context handed to the agent |
|---|---|---|---|
| **Faster Fixes** | ✅ AGPL-3.0 (dashboard+API+MCP), widgets MIT — full self-host, free | ✅ `@fasterfixes/mcp` | page URL, **exact DOM element**, **console logs**, **network requests**, screenshot, full browser context |
| **BugPin** | ✅ open-source, **SQLite + Docker**, GitHub integration | positioned for AI agents | screenshot + annotations (draw / arrows / text), GitHub |
| **Marker.io** | ❌ SaaS (from ~$59/mo) | ✅ Marker MCP | screenshot, console logs, network requests, browser details |
| **BugHerd** | ❌ SaaS (from ~$42/mo) | ✅ BugHerd MCP | feedback queue; agent makes changes in code / CMS / design tool |
| **tester-huester (us)** | ✅ self-host, `node:sqlite`, zero-dep | ✅ `list_reports` / `get_report` / `set_status` / `get_repro_steps` | screenshot + note + pageUrl + viewport + userAgent, **plus a PII-masked ReproBundle: per-interacted-element DOM selector, console logs (+ uncaught errors), network-request metadata (fetch/XHR, no bodies/headers), and an action trail with numbered repro steps** — no full DOM snapshot / no session replay |

### The two we most resemble

- **Faster Fixes** — practically the same thesis as ours: open-source, self-hostable, dashboard + API +
  MCP server that works with Claude Code / Cursor / Codex / Gemini CLI. This is the closest competitor;
  assume a knowledgeable user comparing us will find it.
- **BugPin** — eerily close on *stack*: self-hosted, SQLite, Docker, screenshot annotation, GitHub. Our
  architecture is not novel on its own.

## Implications for the roadmap

1. **"MCP-native self-hosted" is entry cost, not a differentiator.** An open-source competitor (Faster
   Fixes) already ships exactly this promise. Do not position or prioritize as if MCP alone sets us apart.

2. **Our agent-facing context is the real gap.** We currently send
   `screenshot + note + pageUrl + viewport + userAgent`. The leaders send **DOM selector + console logs +
   network requests**. For a product whose whole value is "the agent fixes the bug from the report," this
   is a core capability gap, *not* a v2 nicety — it's the difference between an agent that can act and one
   that has to guess from a picture. **Highest-leverage build item.**

   **Update (2026-07-18):** this gap is now largely closed. Reports ship a MAIN-world, PII-masked
   **ReproBundle** — **per-interacted-element DOM selector + console logs + network-request metadata +
   action trail** — so an agent gets structured, fixable context, not just a picture. Precise scope: this
   is **selector-level** DOM (CSS/role/name/text/testid for elements the tester actually touched), **not** a
   full DOM/AX snapshot; network capture is **metadata only** (method/URL/status/timing, no bodies or
   headers); and there is **no session replay** (one still screenshot + bounded rings). Reaches parity with
   the leaders on structured page context; the untaken tier is a full DOM/AX snapshot + request/response
   bodies + replay. So agent-context is no longer the differentiating gap — refocus the moat discussion on
   the eRENTAL-origin vertical workflow (implication #3).

3. **Candidate real moats** (pick a sharp angle — mere existence won't win):
   - **Deeper agent context** — capture console/network/DOM-selector to reach parity on the axis that
     matters. Baseline requirement to compete at all.
   - **eRENTAL-origin workflow** — if the testers + personal-codes + `/qa` board maps to a specific
     vertical workflow (rental/marketplace QA), that niche workflow is defensible in a way a horizontal
     bug-reporter is not. This is the most likely genuine moat.
   - **Licensing / privacy** — Faster Fixes' server is AGPL-3.0; a friendlier license (e.g. MIT) or a
     simpler self-host story is a real argument for some teams.

## Open questions to resolve before committing more build effort

- Is the goal a horizontal Marker.io/Faster-Fixes competitor, or a vertical QA tool for the
  eRENTAL-style workflow? The answer changes almost everything downstream.
- Are we willing to invest in console/network/DOM capture in the extension? Without it we are strictly
  behind Faster Fixes and Marker.io on the core promise.

## Sources

- Best Visual Bug Tracking Tools 2026 — OverlayQA: https://overlayqa.com/blog/visual-bug-tracking-tools/
- 9 BugHerd Alternatives (Open Source + Free) — FasterFixes: https://www.faster-fixes.com/blog/bugherd-alternatives
- Faster Fixes — MCP server for client feedback: https://www.faster-fixes.com/integrations/mcp
- BugPin — self-hosted open-source visual bug reporting: https://bugpin.io/
- Marker.io MCP: https://marker.io/marker-mcp
- BugHerd MCP: https://bugherd.com/feature/mcp
- Best Bug Reporting Tools 2026 — Crosscheck: https://crosscheck.cloud/blogs/best-bug-reporting-tools-2026/
