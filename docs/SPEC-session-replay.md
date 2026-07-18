# SPEC — Session replay ("last 2 minutes") + blob storage

## Goal

Attach a replayable reconstruction of the moments leading to a bug — the "video" a tester wishes they'd
had. Not a screen recording: a compact **rrweb DOM event stream**, so it's small, privacy-maskable, and
(the north star) also machine-readable — the same "one capture, two consumers" thesis as the repro bundle.

## Why rrweb, not screen video

- **Size**: a DOM event stream is a fraction of a pixel video for the same duration.
- **Privacy**: `maskAllInputs` strips field values *before* recording; you can't mask pixels after the fact.
  (Naïve screen/DOM recorders are what got LogRocket/FullStory sued for wiretapping.)
- **Two consumers**: a human watches the replay; an agent can read the DOM timeline. Pixels are opaque to an
  agent — this keeps replay on-thesis (MCP-native).

## Capture (extension)

- `apps/extension/lib/replay.ts` — wraps `rrweb.record` into a **circular buffer**. rrweb emits a fresh full
  snapshot every `checkoutEveryNms` (60 s); we keep events in a segmented matrix, drop old segments
  (`MAX_SEGMENTS = 4`, bounded memory), and on capture flatten the last `KEEP_SEGMENTS = 3` (~2 min).
  `sliceRecentEvents` re-anchors the slice to a `Meta`+`FullSnapshot` pair so a Replayer can always boot
  (rrweb's checkout splits Meta and FullSnapshot across the segment boundary) — unit-tested.
- Runs in the **isolated** content script (`content.ts`): rrweb observes the shared DOM, so it doesn't need
  the MAIN world. Starts on load, gated by the `recordReplay` config (default on, opt-out in the popup).
  `maskAllInputs: true`; our own overlay host is tagged `th-replay-block` so it never enters the recording.
- **Snapshot at trigger time** (before the overlay mounts), same as the repro bundle, so the tester's own
  clicks aren't in the replay. Size-capped (skip if serialized > 4 MB).

## Transport + storage

- The replay rides in the ingest body as `replay: Event[]`. Because it's large it does **not** go in the
  report row — `/api/ingest` stores it via `storage.putJson({events})` and keeps only `replay_url`.
- `apps/web/lib/storage.ts` writes blobs (screenshots + replay JSON) to a data dir (`UPLOAD_DIR` or
  `.data/uploads`, gitignored) and returns a `/api/asset/<name>` URL. **This fixes the prod-serving gap**:
  `public/` won't serve files written after build; the `/api/asset/[name]` route reads from the data dir and
  streams them, with a strict `^[\w-]+\.(png|jpg|jpeg|webp|json)$` name guard + a resolved-path traversal
  check. Swap `LocalDiskStorage` for R2/S3 later without touching callers.
- DB: nullable `replay_url text` on `reports`, idempotent `ALTER TABLE` migration.

## Playback (dashboard)

- `components/ReplayPlayer.tsx` — client-only, lazy-loads rrweb and uses the **`Replayer` engine directly**
  (the `rrweb-player` Svelte wrapper doesn't mount cleanly under React Strict Mode) with a small custom
  controller. The recorded viewport is scaled to fit the panel width. Progress is driven by `setInterval`
  from wall-clock elapsed, **not** `requestAnimationFrame` (rAF pauses when the tab is hidden) and **not**
  rrweb's `getCurrentTime()` (unreliable in this build).

## Verification

- Unit: `apps/extension/lib/replay.test.ts` — circular-buffer trim + Meta/FullSnapshot re-anchor + fallbacks.
- e2e: `apps/mcp/src/replay-e2e.ts` — POST events → stored as a blob → `replay_url` on the report → the
  `/api/asset` route serves them back → path-traversal blocked.
- Live: recorded a real rrweb session in-browser, posted it, and confirmed the dashboard player reconstructs
  the actual DOM into an iframe and the controller plays through to the end.

## Known limits / next

- rrweb blind spots inherit from capture: cross-origin iframes aren't recorded; canvas/media are off by
  default. Storage is local-disk until an R2/S3 impl lands (interface is ready). No retention/GC on blobs yet.
- Next: action-trail → Playwright script (deterministic repro an agent runs); then the Stage-3 "agent hands".
