import { ImageAnnotator, DEFAULT_COLORS } from '@th/core'
import type { Prim, ReproBundle, Tool, Width } from '@th/core'
import { getConfig, setConfig } from '@/lib/config'
import { buildReport, type ReportType, type Severity } from '@/lib/report'
import { requestBundle } from '@/lib/bridge'
import { loadDraft, saveDraft, flushDrafts, clearDraft, hasContent, type Draft, type DraftVideo } from '@/lib/draft'
import { ICON_RECT, ICON_ARROW, ICON_ELLIPSE, ICON_PENCIL, ICON_CROP, ICON_TEXT, ICON_ERASER, TOOL_CURSORS, TOOL_LABELS } from '@/lib/glyphs'
import {
  startReplay, bindVisibility, snapshotReplay, startExplicitClip, stopExplicitClip, clipSeconds,
  spanSeconds, recorderDiag, trimClip, trimPoints, REPLAY_BLOCK_CLASS, type RREvent,
} from '@/lib/replay'

// The in-page overlay. Lives in a shadow root so the host site's CSS can't touch it. Background hands us a
// screenshot; we let the tester draw / annotate / note, then post it (via background) to the collector.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Idempotent load guard: the declarative injection and the background warm-up / on-demand injection can
    // both target the same frame (they share this isolated-world global). Run the setup exactly once so we
    // never end up with two rrweb recorders or two overlay listeners.
    const g = globalThis as unknown as { __thLoaded?: boolean }
    if (g.__thLoaded) return
    g.__thLoaded = true

    // Start buffering the last ~2 min of DOM replay immediately (opt-out via popup). Runs in the isolated
    // world but observes the shared DOM, which is all rrweb needs.
    getConfig()
      .then((c) => {
        if (!c.recordReplay) return
        startReplay()
        bindVisibility() // only the foreground tab records — background tabs cost nothing
      })
      .catch(() => {})

    let open = false
    const origin = location.origin

    // One path to a mounted overlay, so the shortcut and the automatic post-reload restore are wired
    // identically. The `open` flag is raised synchronously, before the first await, so two triggers landing
    // back-to-back cannot mount two overlays.
    const openOverlay = async (shot: string, draft: Draft | null): Promise<void> => {
      if (open) return
      open = true
      // Snapshot the repro bundle (action trail/console/net) at trigger — before the overlay mounts — so the
      // tester's own clicks on our UI don't pollute it. The REPLAY, however, is snapshotted at SEND time (the
      // overlay is block-classed out of the recording): this way a recorder that only just started on a freshly
      // injected tab still has produced frames by the time the report is sent, instead of an empty capture.
      const context = await requestBundle().catch(() => null)
      mount(shot, context, draft, () => snapshotReplay(), () => { open = false })
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'TH_OPEN' && !open) {
        void loadDraft(origin)
          .catch(() => null)
          .then((draft) => openOverlay(msg.shot as string, draft))
        return undefined
      }
      // The editor window has no access to the page's MAIN-world probe; this content script owns that bridge,
      // so it answers on the window's behalf.
      if (msg?.type === 'TH_CTX') {
        requestBundle()
          .then((bundle) => sendResponse({ ok: true, bundle }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }))
        return true
      }
      // The standalone window is about to open: whatever is on screen here must be in the draft first, and
      // this overlay must stop writing to it afterwards.
      if (msg?.type === 'TH_ED_TAKEOVER') {
        const hand = liveTakeover
        if (!hand) { sendResponse({ ok: true, had: false }); return undefined }
        hand()
          .then(() => sendResponse({ ok: true, had: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }))
        return true
      }
      return undefined
    })

    // A capture that was on screen when the page died comes BACK on its own. The site under test is a dev
    // server that reloads on every save; making the tester press the shortcut again would look exactly like
    // the work had been lost, which is the failure this whole store exists to remove. Top frame only — every
    // iframe runs this same script, and one overlay per page is one too many already.
    if (window.top === window) {
      void (async () => {
        const draft = await loadDraft(origin).catch(() => null)
        if (!draft?.open || !hasContent(draft)) return
        // Only the SAME page coming back counts as "the page died under me". Navigating elsewhere on the site
        // is a deliberate move, and having the overlay pop up on every page of the origin for the rest of the
        // day would be its own kind of broken — the draft is still there, one shortcut press away.
        if (draft.pageUrl !== location.href) return
        let shot = draft.shot?.dataUrl ?? ''
        if (!shot) {
          const res = await chrome.runtime.sendMessage({ type: 'TH_SHOT' }).catch(() => null)
          if (res?.ok && res.shot) shot = res.shot as string
        }
        await openOverlay(shot, draft)
      })()
    }
  },
})

// Set while an overlay is mounted: the background asks THIS overlay to hand its work over to the standalone
// editor window before opening it. Module-scoped because the message listener lives outside mount()'s closure.
let liveTakeover: (() => Promise<void>) | null = null

// Report kinds, each with its own label + icon; the overlay title reflects the current selection.
const TYPES: { value: ReportType; label: string; icon: string }[] = [
  { value: 'feature', label: 'Фича', icon: '💡' },
  { value: 'bug', label: 'Баг', icon: '🐞' },
  { value: 'fix', label: 'Правка', icon: '✏️' },
  { value: 'text', label: 'Текст', icon: '📝' },
]
const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'med', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'crit', label: 'crit' },
]
const WIDTHS: { value: Width; label: string }[] = [
  { value: 'thin', label: 'Тонкая' },
  { value: 'med', label: 'Средняя' },
  { value: 'thick', label: 'Толстая' },
]


const CSS = `
:host, * { box-sizing: border-box; }
.scrim { position: fixed; inset: 0; background: rgba(3,7,18,.82); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 16px; font: 14px system-ui, sans-serif; }
/* Two columns: every control lives in a narrow left rail, so the screenshot gets the whole right side and the
   comment box spans the full width beneath it. Nothing is ever pushed off-screen — the canvas is the only
   element that flexes, everything else keeps its natural size. */
.card { position: relative; display: flex; flex-direction: column; gap: 8px; width: 98vw; max-width: 98vw; height: 96vh; max-height: 96vh; background: #131a2b; color: #e6edf7; border: 1px solid #223049; border-radius: 14px; padding: 12px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.7); overflow: hidden; }
.head { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
/* Restored-draft bar: the tester must be told their old work is on screen, and must be able to refuse it in
   one click. Amber rather than green — this is "here is something you left behind", not "all good". */
.rest { display: none; align-items: center; gap: 10px; flex: 0 0 auto; padding: 8px 12px; border: 1px solid #a16207; background: rgba(161,98,7,.16); border-radius: 10px; font-size: 12.5px; font-weight: 700; color: #fcd34d; }
.rest.on { display: flex; }
.rest b { color: #fff; }
.restx { margin-left: auto; height: 28px; padding: 0 12px; flex: 0 0 auto; border: 1px solid #a16207; background: transparent; color: #fcd34d; border-radius: 8px; font: inherit; font-weight: 800; cursor: pointer; }
.restx:hover { background: rgba(161,98,7,.32); }
.title { font-weight: 800; }
.head .x { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; border: 1px solid #223049; background: #0f1626; color: #8ea0bd; cursor: pointer; }

.body { display: flex; gap: 10px; flex: 1 1 auto; min-height: 0; }
/* The rail's action buttons are pinned: only the controls above them scroll, so Send/Cancel/record are
   reachable at any window height instead of hiding below an overflow. */
.side { flex: 0 0 232px; width: 232px; display: flex; flex-direction: column; gap: 7px; min-height: 0; }
/* Middle section scrolls only when the viewport is genuinely too short (short laptops); otherwise everything
   is visible without a scrollbar. Never clip: cutting off controls the tester will never find is worse than
   a thin scrollbar. The footer (record/send/cancel) stays pinned below via .sidefoot. */
.sidescroll { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 7px; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; padding-right: 3px; }
.sidescroll::-webkit-scrollbar { width: 6px; }
.sidescroll::-webkit-scrollbar-thumb { background: #2b3a55; border-radius: 3px; }
.main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.cvwrap { flex: 1 1 auto; min-height: 90px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.canvas { display: block; max-width: 100%; max-height: 100%; border-radius: 10px; border: 1px solid #223049; background: #0f1626; touch-action: none; cursor: crosshair; }
/* System cursor is hidden while the pointer is over the canvas; a live SVG glyph follows the pointer via JS
   (see .tcur). That matches how graphics apps show tools — a tiny badge that IS the tool, not a generic arrow. */
.canvas { cursor: none; }
.tcur { position: fixed; z-index: 2147483646; pointer-events: none; display: none; width: 22px; height: 22px; margin: -2px 0 0 -2px; color: #e6edf7; filter: drop-shadow(0 1px 2px rgba(0,0,0,.9)); }
.tcur.on { display: block; }
.tcur svg { display: block; width: 22px; height: 22px; }
.tcur svg .fill { fill: currentColor; stroke: #0b1220; stroke-width: 1.2; stroke-linejoin: round; }
.tcur svg .stroke { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; paint-order: stroke; }
.tcur svg .shadow { fill: none; stroke: #0b1220; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
/* Where the icon's "hot point" sits relative to its top-left, per tool — matches Photoshop conventions:
   crosshair centred for shapes, tip for pencil/eraser, top-left crop, I-beam centred. */
.tcur[data-tool="rect"], .tcur[data-tool="arrow"], .tcur[data-tool="ellipse"] { transform: translate(-11px, -11px); }
.tcur[data-tool="text"] { transform: translate(-11px, -11px); }
.tcur[data-tool="crop"] { transform: translate(0, 0); }
.tcur[data-tool="draw"] { transform: translate(-1px, -20px); }
.tcur[data-tool="eraser"] { display: none !important; } /* the brush ring on-canvas IS the eraser cursor */

/* left rail groups */
.grp { display: flex; flex-direction: column; gap: 5px; }
.grpttl { font-size: 9.5px; font-weight: 800; color: #8ea0bd; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 1px; }
.rowx { display: flex; gap: 5px; flex-wrap: wrap; }
.side .tb { height: 30px; padding: 0 9px; flex: 0 0 auto; }
.side .seg { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
.side .seg.sev { grid-template-columns: repeat(4, 1fr); }
.side .seg button { height: 28px; padding: 0 4px; border-right: 1px solid #223049; border-bottom: 1px solid #223049; font-size: 11.5px; }
.side .psel { width: 100%; max-width: 100%; }
.sidefoot { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid #223049; }
.sidefoot .btn { margin-left: 0; width: 100%; height: 38px; }
.sidefoot .msg { min-height: 15px; line-height: 1.25; }
.canvas.crop { cursor: cell; }
.canvas.text { cursor: text; }
.canvas.eraser { cursor: pointer; }
.tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.grpkey { color: #64748b; font-weight: 700; font-size: 9px; text-transform: none; letter-spacing: 0; margin-left: 6px; }
.grpttl { display: flex; align-items: center; gap: 6px; }
.lyt { position: relative; margin-left: auto; }
.lytbtn { border: 1px solid #223049; background: #0f1626; color: #8ea0bd; font-size: 10px; font-weight: 800; text-transform: none; letter-spacing: 0; padding: 2px 7px; border-radius: 6px; cursor: pointer; }
.lytbtn:hover { color: #e6edf7; border-color: #38bdf8; }
.lytname { color: #e6edf7; }
.lytpop { display: none; position: absolute; z-index: 14; right: 0; top: 22px; min-width: 210px; padding: 6px; background: #131a2b; border: 1px solid #2b3a55; border-radius: 10px; box-shadow: 0 14px 34px rgba(0,0,0,.6); flex-direction: column; gap: 4px; }
.lytpop.on { display: flex; }
.lyto { text-align: left; padding: 8px 10px; border: 1px solid transparent; background: transparent; color: #e6edf7; border-radius: 8px; cursor: pointer; font: inherit; }
.lyto:hover { background: #0f1626; border-color: #223049; }
.lyto b { display: block; font-size: 12px; margin-bottom: 3px; }
.lyto i { font-style: normal; font-size: 10.5px; color: #8ea0bd; font-weight: 600; line-height: 1.35; }
.lyto.on { background: rgba(10,132,255,.12); border-color: rgba(10,132,255,.6); }
.tools { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.tools .tb { height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.acts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 3px; }
.acts .tb { height: 26px; padding: 0; }

/* colour slider — the palette painted as a horizontal bar, a small ring rides above the active swatch;
   click anywhere to jump, drag the ring to scrub. */
.cbar { position: relative; height: 22px; border-radius: 6px; cursor: pointer; user-select: none; overflow: visible;
  background: linear-gradient(to right,
    #ff3b30 0%, #ff3b30 8.33%,
    #ff9500 8.33%, #ff9500 16.66%,
    #ffcc00 16.66%, #ffcc00 25%,
    #34c759 25%, #34c759 33.33%,
    #00c7be 33.33%, #00c7be 41.66%,
    #0a84ff 41.66%, #0a84ff 50%,
    #5856d6 50%, #5856d6 58.33%,
    #af52de 58.33%, #af52de 66.66%,
    #ff2d55 66.66%, #ff2d55 75%,
    #ffffff 75%, #ffffff 83.33%,
    #8e8e93 83.33%, #8e8e93 91.66%,
    #0c1526 91.66%, #0c1526 100%);
  border: 1px solid #223049;
}
.cknob { position: absolute; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
  background: currentColor; border: 2px solid #fff; box-shadow: 0 0 0 1px #0f1626, 0 2px 6px rgba(0,0,0,.6);
  pointer-events: none; transition: left .06s linear; }

/* width slider — a tapered wedge, the knob shows the current thickness as a dot */
.wbar { position: relative; height: 30px; border-radius: 6px; cursor: pointer; user-select: none;
  background: linear-gradient(to right, #0f1626, #0f1626); border: 1px solid #223049; overflow: visible; padding: 0 12px;
  display: flex; align-items: center; }
.wwedge { flex: 1; height: 20px; background: linear-gradient(to right, transparent, transparent);
  clip-path: polygon(0 45%, 100% 0, 100% 100%, 0 55%); background-color: #e6edf7; opacity: .85; border-radius: 3px; }
.wknob { position: absolute; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
  background: #0a84ff; border: 2px solid #fff; box-shadow: 0 0 0 1px #0f1626, 0 2px 6px rgba(0,0,0,.6);
  pointer-events: none; transition: left .06s linear; }
.wtags { display: flex; justify-content: space-between; padding: 0 2px; font-size: 9.5px; font-weight: 700; color: #8ea0bd; text-transform: none; letter-spacing: 0; margin-top: 2px; }

.sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25); cursor: pointer; padding: 0; }
.sw:hover { transform: scale(1.12); }
.sw.on { border-color: #e6edf7; box-shadow: 0 0 0 2px #131a2b, 0 0 0 3px #38bdf8; }
/* colour picker: current swatch + a popover grid of the full palette */
.cpick { position: relative; }
.cpcur { display: flex; align-items: center; gap: 7px; width: 100%; height: 32px; padding: 0 9px; border: 1px solid #223049; background: #0f1626; border-radius: 8px; cursor: pointer; }
.cpcur:hover { border-color: #38bdf8; }
.cpdot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); flex: 0 0 auto; }
.cpcar { margin-left: auto; color: #8ea0bd; font-size: 11px; }
.cppop { display: none; position: absolute; z-index: 14; top: 36px; left: 0; grid-template-columns: repeat(6, 1fr); gap: 7px; padding: 9px; background: #131a2b; border: 1px solid #2b3a55; border-radius: 10px; box-shadow: 0 14px 34px rgba(0,0,0,.6); }
.cppop.on { display: grid; }
.tb { height: 32px; padding: 0 11px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.tb.on { border-color: #0a84ff; background: #0a84ff; color: #fff; }
.tb:disabled { opacity: .4; cursor: default; }
.vsep { width: 1px; align-self: stretch; background: #223049; margin: 2px 3px; }
.sep { flex: 1; }
.meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.meta label { font-size: 11.5px; font-weight: 800; color: #8ea0bd; text-transform: uppercase; letter-spacing: .04em; }
.seg { display: inline-flex; border: 1px solid #223049; border-radius: 8px; overflow: hidden; }
.seg button { height: 30px; padding: 0 11px; border: 0; border-right: 1px solid #223049; background: #0f1626; color: #e6edf7; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.seg button:last-child { border-right: 0; }
.seg button.on { background: #0a84ff; color: #fff; }
.seg.sev button.on[data-v="low"] { background: #3f6212; }
.seg.sev button.on[data-v="med"] { background: #a16207; }
.seg.sev button.on[data-v="high"] { background: #c2410c; }
.seg.sev button.on[data-v="crit"] { background: #b91c1c; }
.psel { height: 30px; padding: 0 9px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer; max-width: 190px; }
.psel:hover { border-color: #38bdf8; }
.khint { margin-left: auto; font-size: 11px; font-weight: 700; color: #8ea0bd; }
.khint b { color: #38bdf8; font-weight: 800; }
/* the comment box: full width under the canvas, a comfortable share of the height */
.note { width: 100%; flex: 0 0 26%; min-height: 74px; padding: 10px 13px; background: #0f1626; border: 1px solid #223049; border-radius: 10px; color: #e6edf7; font: inherit; line-height: 1.45; resize: none; outline: none; }
.note:focus { border-color: #38bdf8; }
/* Short viewports / narrow windows: tighten the rail rather than pushing anything out of reach. */
@media (max-height: 900px) {
  .side .tb { height: 28px; padding: 0 8px; }
  .side .seg button { height: 26px; }
  .sidefoot .btn { height: 34px; }
  .note { flex-basis: 22%; min-height: 62px; }
}
@media (max-height: 760px) {
  .card { gap: 6px; padding: 10px; }
  .khint, .ctxhint { display: none; }
  .side { flex-basis: 210px; width: 210px; gap: 7px; }
  .note { flex-basis: 20%; min-height: 54px; }
}
@media (max-width: 1100px) {
  .side { flex-basis: 200px; width: 200px; }
}
.foot { display: flex; align-items: center; gap: 10px; }
.msg { color: #8ea0bd; font-size: 12.5px; }
.msg.err { color: #ff6b6b; }
.msg.warn { color: #fbbf24; }
.msg.ok { color: #34d399; }
.ctxhint { margin-left: auto; font-size: 11.5px; font-weight: 700; color: #8ea0bd; display: flex; gap: 6px; align-items: center; }
.ctxhint b { color: #38bdf8; font-weight: 800; }
.ctxhint .e { color: #fda4af; }
.btn { margin-left: auto; height: 40px; padding: 0 20px; border: 0; border-radius: 10px; background: #0a84ff; color: #fff; font-weight: 800; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: default; }
.ghost { background: transparent; border: 1px solid #223049; color: #e6edf7; }
.tin { position: fixed; z-index: 12; display: none; flex-direction: column; gap: 6px; padding: 8px; background: #0f1626; border: 1px solid #0a84ff; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.6); }
.tin input { width: 260px; height: 32px; padding: 0 10px; background: #131a2b; border: 1px solid #223049; border-radius: 7px; outline: none; color: #e6edf7; font: 800 15px system-ui, sans-serif; }
.tinrow { display: flex; align-items: center; gap: 6px; }
.tinsz { display: inline-flex; gap: 4px; }
.tinsz button { width: 26px; height: 24px; border: 1px solid #223049; background: #131a2b; color: #e6edf7; border-radius: 6px; font-weight: 800; font-size: 12px; cursor: pointer; }
.tinsz button.on { border-color: #0a84ff; background: #0a84ff; color: #fff; }
.tinhint { margin-left: auto; font-size: 11px; color: #8ea0bd; font-weight: 700; white-space: nowrap; }
.tinhint b { color: #38bdf8; }
.tmark { position: fixed; z-index: 11; display: none; width: 12px; height: 12px; margin: -6px 0 0 -6px; pointer-events: none; border: 2px solid #0a84ff; border-radius: 50%; box-shadow: 0 0 0 2px rgba(3,7,18,.6); }
.recst { font-size: 11.5px; font-weight: 800; white-space: nowrap; }
.recst.ok { color: #34d399; }
.recst.warn { color: #fbbf24; }
/* "attach the recording?" block — lives in the left rail, stacked to fit its width */
.clip { display: none; flex-direction: column; gap: 6px; padding: 8px 9px; border: 1px solid #223049; border-radius: 10px; background: #0f1626; }
.clip.on { display: flex; }
.clipq { font-size: 11.5px; font-weight: 700; line-height: 1.3; }
.clipq b { color: #38bdf8; }
.clipst { font-size: 11px; font-weight: 700; color: #34d399; line-height: 1.3; }
.clipst.off { color: #8ea0bd; }
.clipbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.clipb2 { height: 28px; padding: 0 6px; border: 1px solid #223049; background: #131a2b; color: #e6edf7; border-radius: 8px; font-size: 11.5px; font-weight: 700; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clipb2:hover { border-color: #38bdf8; }
.clipb2.pri { border-color: #0a84ff; background: #0a84ff; color: #fff; grid-column: 1 / -1; }

/* the trim editor: a real player with in/out marks, shown INSTEAD of the annotation screen (same card, so the
   tester never loses the report they were writing) */
.card.editing > .body { display: none; }
.ed { display: none; flex-direction: column; gap: 10px; }
.card.editing .ed { display: flex; flex: 1 1 auto; min-height: 0; overflow: auto; }
.edhead { display: flex; align-items: center; gap: 10px; }
.edttl { font-weight: 800; }
.edhint { font-size: 11.5px; color: #8ea0bd; font-weight: 700; }
/* The stage takes ALL the room the editor has left (it is the thing the tester is actually looking at), and
   the recorded frame is scaled to fit inside it and centred. Sizing it from a fraction of the window made the
   preview a 460x220 thumbnail of a 1536x735 recording — too small to tell what you were cutting. */
.edstage { position: relative; flex: 1 1 auto; min-height: 220px; background: #fff; border: 1px solid #223049; border-radius: 10px; overflow: hidden; }
.edstage .replayer-wrapper { position: absolute; top: 50%; left: 50%; transform-origin: center center; }
.edstage iframe { border: 0; background: #fff; }
/* rrweb's own stylesheet lives outside this shadow root, so the replayed cursor needs re-declaring here. */
.edstage .replayer-mouse { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; background: rgba(10,132,255,.35); border: 2px solid #0a84ff; box-shadow: 0 0 0 2px rgba(255,255,255,.6); transition: left .12s linear, top .12s linear; z-index: 3; pointer-events: none; }
.edstage .replayer-mouse.active::after { content: ''; position: absolute; inset: -6px; border: 2px solid #0a84ff; border-radius: 50%; animation: thclick .3s ease-out; }
@keyframes thclick { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
.edbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.edplay { width: 42px; height: 34px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 9px; font-size: 14px; cursor: pointer; }
.edplay:hover { border-color: #38bdf8; }
.edt { font-size: 12px; font-weight: 800; color: #8ea0bd; font-variant-numeric: tabular-nums; min-width: 40px; }
.edtrack { position: relative; flex: 1; min-width: 220px; height: 34px; display: flex; align-items: center; }
.edsel { position: absolute; top: 9px; height: 16px; background: rgba(10,132,255,.28); border-left: 2px solid #0a84ff; border-right: 2px solid #0a84ff; pointer-events: none; border-radius: 2px; }
.edseek { width: 100%; accent-color: #38bdf8; cursor: pointer; }
.edmark { height: 30px; padding: 0 11px; border: 1px solid #223049; background: #0f1626; color: #e6edf7; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
.edmark:hover { border-color: #0a84ff; }
.edsum { font-size: 12px; font-weight: 700; color: #e6edf7; white-space: nowrap; }
.edsum b { color: #38bdf8; }
.edfoot { display: flex; align-items: center; gap: 10px; }
.btn.rec { margin-left: auto; border-color: #b91c1c; color: #fca5a5; }
.btn.rec:hover { border-color: #ef4444; color: #fff; }
`

// The floating "recording" bar shown while an explicit repro is being recorded (its own shadow host, tagged
// with REPLAY_BLOCK_CLASS so it never enters the recording).
const BAR_CSS = `
:host, * { box-sizing: border-box; }
.bar { display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; background: #131a2b; color: #e6edf7; border: 1px solid #b91c1c; border-radius: 12px; font: 13px system-ui, sans-serif; box-shadow: 0 20px 50px -12px rgba(0,0,0,.7); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: thpulse 1.2s infinite; }
@keyframes thpulse { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,.6); } 70% { box-shadow: 0 0 0 8px rgba(239,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); } }
.lbl { font-weight: 700; }
.tm { font-variant-numeric: tabular-nums; color: #8ea0bd; font-weight: 800; min-width: 36px; }
.stop { height: 32px; padding: 0 14px; border: 0; border-radius: 9px; background: #b91c1c; color: #fff; font-weight: 800; cursor: pointer; }
.stop:hover { background: #dc2626; }
`

// Gzip a string to base64 using the platform's CompressionStream (Chrome 80+). Returns '' when unavailable or
// on failure, so the caller can fall back to the uncompressed path rather than losing the recording.
async function gzipToBase64(s: string): Promise<string> {
  try {
    const CS = (globalThis as { CompressionStream?: new (f: string) => GenericTransformStream }).CompressionStream
    if (!CS) return ''
    const stream = new Blob([s]).stream().pipeThrough(new CS('gzip'))
    const buf = new Uint8Array(await new Response(stream).arrayBuffer())
    let bin = ''
    const CHUNK = 0x8000 // chunked to avoid blowing the argument limit on multi-MB clips
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
    return btoa(bin)
  } catch {
    return ''
  }
}

function mount(shot: string, context: ReproBundle | null, draft: Draft | null, getReplay: () => RREvent[], onClose: () => void) {
  const origin = location.origin
  const openingShot = shot // kept aside: "Начать заново" throws the restored frame away and returns to this one
  // Set once the draft has been deliberately discarded (sent, or thrown away by the tester). Nothing may
  // resurrect it after that — not even the close handler writing `open: false`.
  let draftDead = false
  // Set when the standalone editor window has taken this report over. The draft is alive and well — it simply
  // belongs to the window now, and a late debounced write from here would overwrite what the tester has since
  // typed there.
  let handedOver = false
  // The replay attached to this report. Starts as the auto retrospective (evaluated at send); an explicit
  // "record repro" clip replaces it. Kept as a thunk so auto stays live until the moment of sending.
  let replaySource = getReplay
  let recTimer: ReturnType<typeof setInterval> | null = null
  let closed = false
  // Teardown for an in-flight explicit recording, so close() can never orphan the floating bar/timer/listener.
  let activeRec: (() => void) | null = null
  const host = document.createElement('div')
  host.className = REPLAY_BLOCK_CLASS // keep our own overlay out of any ongoing replay recording
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="scrim" part="scrim">
      <div class="card">
        <div class="rest"><span class="restt"></span><button class="restx">Начать заново</button></div>
        <div class="head"><span class="title"></span><span class="recst"></span><span class="ctxhint"></span><button class="x" title="Close">✕</button></div>
        <div class="body">
          <div class="side">
            <div class="sidescroll">
            <div class="grp">
              <span class="grpttl">Инструмент
                <span class="lyt">
                  <button class="lytbtn" title="Раскладка клавиш"><span class="lytname">designer</span> ▾</button>
                  <div class="lytpop">
                    <button class="lyto" data-lyt="designer"><b>Designer</b><i>буквы-мнемоника<br>R А O P C T E</i></button>
                    <button class="lyto" data-lyt="gamer"><b>Gamer (CS)</b><i>инструменты как оружие: 1-7<br>Q — undo · R — redo · Z/X/M — толщина</i></button>
                  </div>
                </span>
              </span>
              <span class="rowx tools">
                <button class="tb tool on" data-tool="rect" title="Рамка · R">${ICON_RECT}</button>
                <button class="tb tool" data-tool="arrow" title="Стрелка · A">${ICON_ARROW}</button>
                <button class="tb tool" data-tool="ellipse" title="Овал · O">${ICON_ELLIPSE}</button>
                <button class="tb tool" data-tool="draw" title="Карандаш · P — сглаженный штрих">${ICON_PENCIL}</button>
                <button class="tb tool" data-tool="crop" title="Кадрирование · C">${ICON_CROP}</button>
                <button class="tb tool" data-tool="text" title="Текст · T">${ICON_TEXT}</button>
                <button class="tb tool" data-tool="eraser" title="Ластик · E — стирает по проведённой линии, размер = толщина">${ICON_ERASER}</button>
                <button class="tb" data-act="undo" disabled title="Отменить · Ctrl+Z">↩</button>
                <button class="tb" data-act="redo" disabled title="Повторить · Ctrl+Y">↪</button>
                <button class="tb" data-act="clear" disabled title="Очистить всё · Shift+Del">🗑</button>
              </span>
            </div>
            <div class="grp">
              <span class="grpttl">Цвет <span class="grpkey">(F — след. цвет)</span></span>
              <div class="cbar" role="slider" aria-label="Цвет"><span class="cknob" style="color:${DEFAULT_COLORS[0]}"></span></div>
            </div>
            <div class="grp">
              <span class="grpttl">Размер <span class="grpkey">(1 / 2 / 3)</span></span>
              <div class="wbar" role="slider" aria-label="Толщина"><span class="wwedge"></span><span class="wknob"></span></div>
              <div class="wtags"><span>тонко</span><span>средне</span><span>толсто</span></div>
            </div>
            <div class="grp">
              <span class="grpttl">Тип</span>
              <div class="seg type">
                ${TYPES.map((t) => `<button data-v="${t.value}"${t.value === 'bug' ? ' class="on"' : ''}>${t.icon} ${t.label}</button>`).join('')}
              </div>
            </div>
            <div class="grp">
              <span class="grpttl">Важность</span>
              <div class="seg sev">
                ${SEVERITIES.map((s) => `<button data-v="${s.value}"${s.value === 'med' ? ' class="on"' : ''}>${s.label}</button>`).join('')}
              </div>
            </div>
            <div class="grp">
              <span class="grpttl">Проект</span>
              <select class="psel"><option value="">по умолчанию</option></select>
            </div>
            <div class="clip">
              <span class="clipq"></span>
              <span class="clipst"></span>
              <span class="clipbtns">
                <button class="clipb2 pri" data-clip="edit">✂ Открыть редактор</button>
                <button class="clipb2" data-clip="all">Целиком</button>
                <button class="clipb2" data-clip="none">Не класть</button>
              </span>
            </div>
            </div>
            <div class="sidefoot">
              <span class="msg"></span>
              <button class="btn ghost rec" title="Записать репро: свернуть окно, воспроизвести баг, ⏹ Стоп — клип прикрепится">🔴 Записать репро</button>
              <button class="btn ghost reshot" title="Переснять кадр: окно свернётся, подготовьте страницу и нажмите «Снять» — заметка, видео и настройки сохранятся">📸 Переснять кадр</button>
              <button class="btn ghost toed" title="Продолжить в отдельном окне: страница больше не сможет помешать — можно добавлять вложения, вставлять картинки из буфера и не бояться перезагрузки сайта">⇗ Открыть в окне</button>
              <button class="btn send">Send</button>
              <button class="btn ghost cancel">Cancel</button>
              <span class="khint"><b>Ctrl+Enter</b> отправить · <b>Esc</b> свернуть (черновик сохранится)</span>
            </div>
          </div>
          <div class="main">
            <div class="cvwrap"><canvas class="canvas"></canvas></div>
            <textarea class="note" placeholder="Что не так? Опишите проблему…"></textarea>
          </div>
        </div>

        <div class="ed">
          <div class="edhead">
            <span class="edttl">✂ Обрезка записи</span>
            <span class="edhint">Проигрывайте запись и отметьте начало и конец нужного отрезка</span>
          </div>
          <div class="edstage"></div>
          <div class="edbar">
            <button class="edplay">▶</button>
            <span class="edt edcur">0:00</span>
            <span class="edtrack"><span class="edsel"></span><input type="range" class="edseek" min="0" max="1000" value="0" /></span>
            <span class="edt edtot">0:00</span>
          </div>
          <div class="edbar">
            <button class="edmark" data-ed="in">[ Начало здесь</button>
            <button class="edmark" data-ed="out">Конец здесь ]</button>
            <button class="edmark" data-ed="preview">▶ Просмотр отрезка</button>
            <button class="edmark" data-ed="reset">Сброс</button>
            <span class="edsum"></span>
          </div>
          <div class="edfoot">
            <button class="btn ghost" data-ed="cancel">← Назад</button>
            <span class="sep"></span>
            <button class="btn ghost" data-ed="drop">Не прикреплять</button>
            <button class="btn" data-ed="save">Прикрепить отрезок</button>
          </div>
        </div>
      </div>
      <div class="tmark"></div>
      <div class="tcur" data-tool="rect"></div>
      <div class="tin">
        <input type="text" placeholder="Текст…" />
        <div class="tinrow">
          <span class="tinsz">
            <button data-tsz="thin">S</button>
            <button data-tsz="med" class="on">M</button>
            <button data-tsz="thick">L</button>
          </span>
          <span class="tinhint"><b>&#8629;</b> поставить &#183; <b>Esc</b> отмена</span>
        </div>
      </div>
    </div>`
  document.documentElement.appendChild(host)

  const q = <T extends Element>(s: string) => root.querySelector(s) as T
  const canvas = q<HTMLCanvasElement>('.canvas')
  const note = q<HTMLTextAreaElement>('.note')
  const msg = q<HTMLElement>('.msg')
  const titleEl = q<HTMLElement>('.title')
  const sendBtn = q<HTMLButtonElement>('.send')
  const undoBtn = q<HTMLButtonElement>('[data-act="undo"]')
  const redoBtn = q<HTMLButtonElement>('[data-act="redo"]')
  const clearBtn = q<HTMLButtonElement>('[data-act="clear"]')
  const tin = q<HTMLElement>('.tin')
  const tinInput = q<HTMLInputElement>('.tin input')
  const tmark = q<HTMLElement>('.tmark')
  const psel = q<HTMLSelectElement>('.psel')
  const recBtn = q<HTMLButtonElement>('.rec')
  const reshotBtn = q<HTMLButtonElement>('.reshot')
  const recstEl = q<HTMLElement>('.recst')
  const clipBox = q<HTMLElement>('.clip')
  const clipQ = q<HTMLElement>('.clipq')
  const clipSt = q<HTMLElement>('.clipst')
  const card = q<HTMLElement>('.card')
  const edStage = q<HTMLElement>('.edstage')
  const edPlay = q<HTMLButtonElement>('.edplay')
  const edSeek = q<HTMLInputElement>('.edseek')
  const edSel = q<HTMLElement>('.edsel')
  const edCur = q<HTMLElement>('.edcur')
  const edTot = q<HTMLElement>('.edtot')
  const edSum = q<HTMLElement>('.edsum')

  // Form state (shared with track A via the exact field names note/type/severity).
  let type: ReportType = draft?.type ?? 'bug'
  let severity: Severity = draft?.severity ?? 'med'
  let projectId: string | null = draft?.projectId ?? null // chosen in the project picker; null → route by the ingest key
  let pendingText: { x: number; y: number } | null = null
  // True while the restored draft is being put back on screen. The annotator fires onChange during that, and
  // autosaving mid-restore would write an empty markup stack over the one we are in the middle of restoring.
  let hydrating = true
  // Attachments belong to the standalone editor window; this overlay has one canvas and cannot show them. It
  // never destroys them either (the draft is shallow-merged), but it must not let the tester send a report
  // that silently drops them, so the count is carried and named wherever it matters.
  const draftAttachments = draft?.attachments?.length ?? 0

  // Everything worth keeping, written to storage on every meaningful change. `immediate` skips the debounce:
  // only note typing can afford to wait, because only note typing happens dozens of times a second.
  function persist(patch: Partial<Draft> = {}, immediate = true): void {
    if (draftDead || handedOver) return
    const write = saveDraft(origin, {
      pageUrl: location.href,
      open: !closed,
      note: note.value,
      type,
      severity,
      projectId,
      prims: ann.getPrims(),
      video,
      context: context ?? null,
      ...patch,
    })
    // A draft that failed to save is worse than no draft — the tester would keep working believing they are
    // covered. Say it out loud instead.
    write.catch((e: unknown) => { if (!closed) setMsg('⚠ Черновик не сохранён: ' + String(e), 'warn') })
    if (immediate) void flushDrafts()
  }

  // The backdrop is stored separately from the markup, so a crop (which replaces the backdrop) survives. Its
  // only reliable outside signal is the canvas changing size, so that is what we watch.
  let lastShotDims = ''
  function persistShotIfChanged(): void {
    const dims = `${canvas.width}x${canvas.height}`
    if (dims === lastShotDims) return
    lastShotDims = dims
    persist({ shot: { dataUrl: ann.toBaseDataURL(0.85) } })
  }

  // Pack everything this overlay holds into the draft and step aside, so the standalone editor window can pick
  // the report up exactly where it stands. The background calls this (TH_ED_TAKEOVER) before opening the
  // window — from the ⇗ button, from the shortcut and from the popup alike, so the handover is one code path.
  async function takeover(): Promise<void> {
    if (closed) return
    // The backdrop is normally written only when the canvas changes size. A handover must not ride on that
    // heuristic: this frame IS the report.
    persist({ shot: { dataUrl: ann.toBaseDataURL(0.85) }, open: false })
    await flushDrafts()
    handedOver = true
    close()
  }

  const close = () => {
    if (closed) return
    closed = true
    liveTakeover = null
    if (activeRec) { activeRec(); activeRec = null } // kill an in-flight recording: bar, timer, listener, recorder
    if (recTimer) clearInterval(recTimer)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pagehide', onPageHide)
    // Esc / ✕ keep the draft — only the flag saying "the overlay was on screen" is cleared, so the next page
    // load does not pop the overlay open by itself.
    persist({ open: false })
    host.remove()
    onClose()
  }

  liveTakeover = takeover

  // The debounce is a race against a page teardown; flush what is buffered while there is still a page.
  const onPageHide = () => { if (!draftDead && !handedOver && !closed) { persist(); void flushDrafts() } }
  window.addEventListener('pagehide', onPageHide)

  // Colour + width scales are set from click AND from hotkey; declared as function statements so the hotkey
  // handler below can reference them safely (JS hoists function declarations, not const arrows).
  function pickColor(c: string): void {
    ann.setColor(c)
    const i = Math.max(0, DEFAULT_COLORS.indexOf(c))
    const knob = root.querySelector('.cknob') as HTMLElement | null
    if (knob) {
      knob.style.left = `${((i + 0.5) / DEFAULT_COLORS.length) * 100}%`
      knob.style.color = c
    }
  }
  function pickWidth(w: Width): void {
    ann.setWidth(w)
    const knob = root.querySelector('.wknob') as HTMLElement | null
    if (knob) {
      knob.style.left = w === 'thin' ? '16%' : w === 'med' ? '50%' : '84%'
      knob.style.width = w === 'thin' ? '12px' : w === 'med' ? '16px' : '22px'
      knob.style.height = knob.style.width
      knob.style.marginLeft = `-${parseInt(knob.style.width, 10) / 2}px`
      knob.style.marginTop = `-${parseInt(knob.style.width, 10) / 2}px`
    }
  }

  // Standard editor hotkeys across the whole overlay. Keyed off e.code (PHYSICAL key: 'KeyP', 'KeyZ', 'Digit1'),
  // NOT e.key — so they work under any keyboard layout (RU/EN/HU) and on every OS, where e.key would return a
  // layout-dependent character (physical P → 'з' on the Russian layout) and the mapping would miss. Single-key
  // shortcuts are skipped while typing in a field; the undo/redo stack is the annotator's unified one (draw+crop).
  // Two hotkey layouts the tester can switch between (a dropdown next to the tools row shows the mapping):
  //   • designer — mnemonic letters (R rectangle, A arrow, O oval, P pencil, C crop, T text, E eraser)
  //   • gamer — CS-style, tools bound to number-row like weapons and the workhorse keys (Q undo, E redo)
  //     so a player-tester keeps left-hand muscle memory and never has to hunt.
  const TOOL_LAYOUTS: Record<'designer' | 'gamer', Record<string, Tool>> = {
    designer: { KeyR: 'rect', KeyA: 'arrow', KeyO: 'ellipse', KeyP: 'draw', KeyC: 'crop', KeyT: 'text', KeyE: 'eraser' },
    gamer: { Digit1: 'rect', Digit2: 'arrow', Digit3: 'ellipse', Digit4: 'draw', Digit5: 'crop', Digit6: 'text', Digit7: 'eraser' },
  }
  const WIDTH_LAYOUTS: Record<'designer' | 'gamer', Record<string, Width>> = {
    designer: { Digit1: 'thin', Digit2: 'med', Digit3: 'thick', Numpad1: 'thin', Numpad2: 'med', Numpad3: 'thick' },
    // In gamer mode the digits pick TOOLS (weapons), so width lives on the middle row — Shift+A/S/D or the QWE
    // above the tools row.
    gamer: { KeyZ: 'thin', KeyX: 'med', KeyM: 'thick' },
  }
  const LAYOUT_KEY = 'th.layout'
  let layout: 'designer' | 'gamer' = (localStorage.getItem(LAYOUT_KEY) as 'designer' | 'gamer' | null) || 'designer'
  const setLayout = (l: 'designer' | 'gamer') => { layout = l; localStorage.setItem(LAYOUT_KEY, l); syncLayoutUI() }
  let TOOL_CODES = TOOL_LAYOUTS[layout]
  let WIDTH_CODES = WIDTH_LAYOUTS[layout]
  const UNDO_KEYS = () => (layout === 'gamer' ? ['KeyQ'] : []) // Ctrl+Z always works too
  const REDO_KEYS = () => (layout === 'gamer' ? ['KeyR'] : [])
  function onKey(e: KeyboardEvent) {
    const ae = root.activeElement as HTMLElement | null
    const typing = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')
    const mod = e.ctrlKey || e.metaKey
    const code = e.code

    if (mod && (code === 'Enter' || code === 'NumpadEnter')) { e.preventDefault(); sendBtn.click(); return } // send
    if (mod && code === 'KeyZ') { if (typing) return; e.preventDefault(); if (e.shiftKey) ann.redo(); else ann.undo(); return }
    if (mod && code === 'KeyY') { if (typing) return; e.preventDefault(); ann.redo(); return } // Ctrl+Y = redo
    if (mod) return // leave other Ctrl/Cmd combos to the browser

    if (code === 'Escape') { if (typing) return; e.preventDefault(); close(); return }
    if (typing) return

    // Gamer-mode single-key aliases for undo/redo (Q/E, CS drop/use muscle memory).
    if (UNDO_KEYS().includes(code)) { e.preventDefault(); ann.undo(); return }
    if (REDO_KEYS().includes(code)) { e.preventDefault(); ann.redo(); return }

    if (e.shiftKey && (code === 'Delete' || code === 'Backspace')) { e.preventDefault(); ann.clearAll(); return }
    const tool = TOOL_CODES[code]
    if (tool) { e.preventDefault(); ann.setTool(tool); refresh(); return }
    const w = WIDTH_CODES[code]
    if (w) {
      e.preventDefault()
      pickWidth(w) // sync the width scale ring
      return
    }
    if (code === 'KeyF') {
      // Cycle through the colour scale — quick recolour without leaving the pointer.
      e.preventDefault()
      const cur = DEFAULT_COLORS.indexOf(ann.color)
      const next = DEFAULT_COLORS[(cur + (e.shiftKey ? -1 : 1) + DEFAULT_COLORS.length) % DEFAULT_COLORS.length]!
      pickColor(next)
    }
  }
  document.addEventListener('keydown', onKey, true)

  const syncTitle = () => {
    const t = TYPES.find((x) => x.value === type)!
    titleEl.textContent = `${t.icon} ${t.label} — сообщить`
  }
  // Reflect the current type/severity onto the segmented controls. Needed because a restored draft can arrive
  // with values the markup's hardcoded defaults do not match.
  const syncTypeSev = () => {
    root.querySelectorAll('.seg.type button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === type))
    root.querySelectorAll('.seg.sev button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === severity))
    syncTitle()
  }
  syncTypeSev()

  // Show the tester what technical context was captured alongside the screenshot.
  const hint = q<HTMLElement>('.ctxhint')
  const bits: string[] = []
  if (context) {
    const errs = (context.console ?? []).filter((c) => c.level === 'error').length
    if (context.actions?.length) bits.push(`<b>${context.actions.length}</b> steps`)
    if (context.console?.length) bits.push(`<b>${context.console.length}</b> console`)
    if (context.network?.length) bits.push(`<b>${context.network.length}</b> net`)
    if (errs) bits.push(`<span class="e"><b>${errs}</b> err</span>`)
  }
  hint.innerHTML = bits.length ? '📋 ' + bits.join(' · ') + ' captured' : ''

  // Live recording indicator — shows the human whether there is a screencast to attach and how long it is, so
  // an empty/short capture is never a silent surprise. Reads the exact replay that WILL be sent (replaySource).
  const spanOf = spanSeconds
  const fmtDur = (s: number) => (s < 60 ? `${Math.round(s)}с` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`)
  // Reports what will ACTUALLY be attached — including whether it would play. A clip whose mutations don't
  // resolve against its snapshot renders as a frozen frame with a moving cursor, so we surface that as broken
  // rather than letting it ship looking fine.
  const updateRec = () => {
    if (closed) return
    const evs = replaySource()
    const s = spanOf(evs)
    const diag = recorderDiag()
    if (s < 1 && diag.lastError) { recstEl.className = 'recst warn'; recstEl.textContent = '⚠ рекордер не запустился на этой странице' }
    else if (s < 1) { recstEl.className = 'recst warn'; recstEl.textContent = '⚠ записи нет — нажми «Записать репро»' }
    else if (s < 3) { recstEl.className = 'recst warn'; recstEl.textContent = `⚠ короткая (${fmtDur(s)})` }
    else { recstEl.className = 'recst ok'; recstEl.textContent = `🔴 запись ${fmtDur(s)}` }
  }
  // ── Attach-the-recording decision + trim editor ──────────────────────────────────────────────────────
  // The tester is ASKED whether the recording should ride along, and can cut it while WATCHING it — blind
  // sliders told them nothing about what they were keeping. The action trail always ships regardless: it is
  // small and it is what an agent actually reads.
  const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`)

  let attach = true // send the recording at all?
  let trim: { from: number; to: number } | null = null // chosen stretch (seconds from clip start), null = whole
  // The recorded tab video (webm as a data URL). This is the primary recording now; the DOM buffer stays only
  // as a small context fallback.
  // The offscreen recorder now uploads directly to /api/upload/video and returns a URL — nothing large ever
  // crosses the MV3 message boundary (which has a 64 MiB per-message cap). We keep only the URL and size.
  // Restored from the draft when there is one: the recording is the most expensive artefact in a report and
  // losing it to a page reload is the worst version of this bug.
  let video: DraftVideo | null = draft?.video ?? null

  // The exact events Send will attach. Physically the clip starts at the checkpoint at/before `from` (a clip
  // must open on a snapshot); `replayTrim` rides alongside so the dashboard plays exactly the chosen stretch.
  function selectedClip(): { events: RREvent[]; trim?: { from: number; to: number } } {
    if (!attach) return { events: [] }
    const evs = replaySource()
    const total = spanOf(evs)
    if (!trim || total < 1) return { events: evs }
    const res = trimClip(evs, trim.from, trim.to)
    return { events: res.events, trim: { from: Math.max(0, trim.from - res.from), to: Math.max(0, trim.to - res.from) } }
  }

  function updateClipPanel() {
    // A recorded VIDEO takes precedence — it is what the tester asked for and what actually shows behaviour.
    if (video) {
      clipBox.classList.add('on')
      clipQ.innerHTML = `🎬 Видео <b>${fmtT(video.seconds)}</b> · ${(video.bytes / 1e6).toFixed(1)} МБ — приложить?`
      clipSt.className = attach ? 'clipst' : 'clipst off'
      clipSt.textContent = !attach
        ? 'не прикладывается'
        : trim
          ? `приложится отрезок ${fmtT(trim.from)}–${fmtT(trim.to)} (${fmtT(Math.max(0, trim.to - trim.from))})`
          : 'приложится целиком'
      return
    }
    const evs = replaySource()
    const total = spanOf(evs)
    if (total < 1) { clipBox.classList.remove('on'); return }
    clipBox.classList.add('on')
    clipQ.innerHTML = `🎬 Есть черновая запись <b>${fmtT(total)}</b> (последние 30 с) — приложить?`
    if (!attach) {
      clipSt.className = 'clipst off'
      clipSt.textContent = 'не прикладывается'
    } else {
      const sel = selectedClip()
      const dur = trim ? Math.max(0, trim.to - trim.from) : total
      clipSt.className = 'clipst'
      clipSt.textContent = `приложится ${fmtT(dur)}${trim ? ` (${fmtT(trim.from)}–${fmtT(trim.to)})` : ' целиком'} · ~${kb(JSON.stringify(sel.events).length / 6)}`
    }
  }

  root.querySelectorAll('[data-clip]').forEach((el) =>
    el.addEventListener('click', () => {
      const act = (el as HTMLElement).dataset.clip
      if (act === 'none') { attach = false; trim = null; updateClipPanel() }
      else if (act === 'all') { attach = true; trim = null; updateClipPanel() }
      else if (act === 'edit') void openEditor()
    }),
  )

  // ── the editor ───────────────────────────────────────────────────────────────────────────────────────
  type Replayerish = {
    play: (offset?: number) => void
    pause: (offset?: number) => void
    destroy?: () => void
    getMetaData: () => { totalTime: number }
  }
  let rep: Replayerish | null = null
  let vid: HTMLVideoElement | null = null // the <video> when trimming a real recording
  let isVideoEditor = false
  let edFit: (() => void) | null = null
  let edTimer: ReturnType<typeof setInterval> | null = null
  let edTotal = 0
  let edIn = 0
  let edOut = 0
  let edPlaying = false
  let edStartWall = 0
  let edStartOff = 0
  let edPreviewTo = 0 // when previewing the selection, stop here

  const edPos = () =>
    isVideoEditor
      ? (vid?.currentTime ?? 0)
      : edPlaying
        ? Math.min(edTotal, edStartOff + (performance.now() - edStartWall) / 1000)
        : (Number(edSeek.value) / 1000) * edTotal

  function edPaint() {
    const pos = edPos()
    edSeek.value = String(edTotal ? Math.round((pos / edTotal) * 1000) : 0)
    edCur.textContent = fmtT(pos)
    edTot.textContent = fmtT(edTotal)
    const l = edTotal ? (edIn / edTotal) * 100 : 0
    const w = edTotal ? ((edOut - edIn) / edTotal) * 100 : 100
    edSel.style.left = `calc(${l}% )`
    edSel.style.width = `calc(${w}% )`
    edSum.innerHTML = `отрезок <b>${fmtT(edIn)} – ${fmtT(edOut)}</b> · ${fmtT(Math.max(0, edOut - edIn))}`
  }

  function edSeekTo(sec: number, keepPlaying = false) {
    const s = Math.max(0, Math.min(edTotal, sec))
    if (isVideoEditor) {
      if (vid) vid.currentTime = s
      edSeek.value = String(edTotal ? Math.round((s / edTotal) * 1000) : 0)
      edPaint()
      return
    }
    if (keepPlaying && edPlaying) { edStartOff = s; edStartWall = performance.now(); rep?.play(s * 1000) }
    else { edPlaying = false; edPlay.textContent = '▶'; rep?.pause(s * 1000); edSeek.value = String(edTotal ? Math.round((s / edTotal) * 1000) : 0) }
    edPaint()
  }

  function edToggle(from?: number, until?: number) {
    if (isVideoEditor) {
      if (!vid) return
      if (!vid.paused) { vid.pause(); return }
      if (from != null) vid.currentTime = from
      else if (vid.currentTime >= edTotal - 0.15) vid.currentTime = 0
      edPreviewTo = until ?? 0
      void vid.play()
      return
    }
    if (edPlaying) { edPlaying = false; edPlay.textContent = '▶'; rep?.pause(edPos() * 1000); return }
    const start = from ?? (edPos() >= edTotal - 0.15 ? 0 : edPos())
    edPreviewTo = until ?? 0
    edStartOff = start
    edStartWall = performance.now()
    edPlaying = true
    edPlay.textContent = '⏸'
    rep?.play(start * 1000)
  }

  // Trim the RECORDED VIDEO: a plain <video> with in/out marks. The editor used to show the DOM replay even
  // after a video was recorded — two different mechanisms, and the DOM one is exactly the thing that plays
  // back without the page's content. What you trim here is what you watched.
  async function openVideoEditor() {
    if (!video) return
    attach = true
    card.classList.add('editing')
    document.removeEventListener('keydown', onKey, true)

    edStage.innerHTML = ''
    const v = document.createElement('video')
    // The clip is no longer carried as a data URL — the offscreen recorder uploads it and hands back the
    // collector-relative path, so it has to be resolved against the collector. Left as `video.dataUrl` this
    // read `undefined` and the trim editor opened on a black rectangle every single time.
    const cfg = await getConfig()
    v.src = cfg.collectorUrl.replace(/\/+$/, '') + video.url
    // The clip is fetched from another origin into the page's own document, so the SITE's media-src can refuse
    // it. Nothing is lost when that happens — the file is already on the collector — but the tester must be
    // told why the picture is black instead of being left to guess.
    v.addEventListener('error', () => setMsg('Видео не открылось для обрезки — страница блокирует внешние медиа. Отправьте как есть: запись уже на сервере.', 'warn'))
    v.preload = 'metadata'
    v.playsInline = true
    v.style.cssText = 'display:block; width:100%; height:100%; object-fit:contain; background:#000;'
    edStage.appendChild(v)
    setMsg('')

    edTotal = video.seconds || 0
    edIn = trim ? trim.from : 0
    edOut = trim ? trim.to : edTotal
    isVideoEditor = true
    vid = v

    v.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(v.duration) && v.duration > 0) edTotal = v.duration
      edOut = trim ? trim.to : edTotal
      edPaint()
    })
    v.addEventListener('timeupdate', () => {
      if (edPreviewTo && v.currentTime >= edPreviewTo) { v.pause(); edPreviewTo = 0 }
      edPaint()
    })
    v.addEventListener('play', () => { edPlaying = true; edPlay.textContent = '⏸' })
    v.addEventListener('pause', () => { edPlaying = false; edPlay.textContent = '▶' })
    edPaint()
  }

  async function openEditor() {
    if (video) return openVideoEditor() // a real recording beats the DOM buffer
    const evs = replaySource()
    if (spanOf(evs) < 1) return
    attach = true
    isVideoEditor = false
    card.classList.add('editing')
    document.removeEventListener('keydown', onKey, true) // the editor owns the keyboard while it is open

    edTotal = spanOf(evs)
    edIn = trim ? trim.from : 0
    edOut = trim ? trim.to : edTotal
    edStage.innerHTML = ''
    setMsg('')

    try {
      const { Replayer } = await import('rrweb')
      rep = new Replayer(evs as never, { root: edStage, skipInactive: false, mouseTail: false }) as unknown as Replayerish
      rep.pause(0)
      // rrweb renders at the recorded viewport; scale it into the editor stage.
      const meta = evs.find((e) => e.type === 4) as { data?: { width?: number; height?: number } } | undefined
      const w = meta?.data?.width || 1280
      const h = meta?.data?.height || 720
      const wrap = edStage.querySelector('.replayer-wrapper') as HTMLElement | null
      // Fit BOTH axes: scaling by width alone let a tall page overflow the stage, so the tester saw only the
      // top-left part of what they were trimming. The stage is then sized to the scaled frame exactly (and
      // centred), so there is no dead space and nothing is cropped.
      // Scale the recorded frame to whatever the stage actually is (CSS flex gives it the leftover space) and
      // centre it. Reads the live box each time, so it stays correct on resize.
      edFit = () => {
        const wr = wrap ?? (edStage.querySelector('.replayer-wrapper') as HTMLElement | null)
        if (!wr) return
        const availW = edStage.clientWidth || 900
        const availH = edStage.clientHeight || 400
        const scale = Math.min(availW / w, availH / h) // may exceed 1: a small recording should fill the stage
        wr.style.transform = `translate(-50%, -50%) scale(${scale})`
      }
      edFit()
      // rrweb finishes laying the iframe out asynchronously; re-fit right after so the first frame is never
      // left at the wrong size, and keep fitting while the editor is open.
      requestAnimationFrame(() => edFit())
      setTimeout(() => edFit(), 200)
      window.addEventListener('resize', edFit)
      edPaint()
      if (edTimer) clearInterval(edTimer)
      edTimer = setInterval(() => {
        if (!edPlaying) return
        const pos = edPos()
        if ((edPreviewTo && pos >= edPreviewTo) || pos >= edTotal) { edPlaying = false; edPlay.textContent = '▶'; rep?.pause((edPreviewTo || edTotal) * 1000); edPreviewTo = 0 }
        edPaint()
      }, 100)
    } catch (e) {
      setMsg('Не удалось открыть редактор: ' + String(e), 'err')
      closeEditor()
    }
  }

  function closeEditor() {
    if (edTimer) { clearInterval(edTimer); edTimer = null }
    if (edFit) { window.removeEventListener('resize', edFit); edFit = null }
    edPlaying = false
    edPreviewTo = 0
    try { vid?.pause() } catch {}
    vid = null
    isVideoEditor = false
    try { rep?.pause(); rep?.destroy?.() } catch {}
    rep = null
    edStage.removeAttribute('style')
    edStage.innerHTML = ''
    card.classList.remove('editing')
    document.addEventListener('keydown', onKey, true)
    updateClipPanel()
  }

  edPlay.addEventListener('click', () => edToggle())
  edSeek.addEventListener('input', () => edSeekTo((Number(edSeek.value) / 1000) * edTotal, true))
  root.querySelectorAll('[data-ed]').forEach((el) =>
    el.addEventListener('click', () => {
      const act = (el as HTMLElement).dataset.ed
      if (act === 'in') { edIn = Math.min(edPos(), edOut - 0.5); edPaint() }
      else if (act === 'out') { edOut = Math.max(edPos(), edIn + 0.5); edPaint() }
      else if (act === 'preview') { edSeekTo(edIn); edToggle(edIn, edOut) }
      else if (act === 'reset') { edIn = 0; edOut = edTotal; edPaint() }
      else if (act === 'cancel') closeEditor()
      else if (act === 'drop') { attach = false; trim = null; closeEditor() }
      else if (act === 'save') {
        attach = true
        trim = edIn <= 0.2 && edOut >= edTotal - 0.2 ? null : { from: edIn, to: edOut }
        closeEditor()
        setMsg(trim ? `Отрезок ${fmtT(trim.from)}–${fmtT(trim.to)} прикреплён ✓` : 'Запись прикреплена целиком ✓', 'ok')
      }
    }),
  )

  updateRec()
  updateClipPanel()
  recTimer = setInterval(() => { updateRec(); updateClipPanel() }, 1500)

  const refresh = () => {
    undoBtn.disabled = !ann.canUndo()
    redoBtn.disabled = !ann.canRedo()
    clearBtn.disabled = !ann.canClear()
    root.querySelectorAll('.tb.tool').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tool === ann.tool))
    // Reflect the current tool on the canvas so its cursor changes accordingly (see .canvas.<tool> rules).
    for (const t of ['rect', 'arrow', 'ellipse', 'text', 'crop', 'draw', 'eraser'] as const) {
      canvas.classList.toggle(t, ann.tool === t)
    }
    paintCursor()
    autosaveMarkup()
  }

  // The annotator's onChange also fires for tool and colour changes, which are not work worth persisting.
  // Compare the markup itself: primitives are few and small, so stringifying them is far cheaper than the
  // storage write it prevents.
  let lastPrimSig = ''
  const primSig = () => JSON.stringify(ann.getPrims())
  function autosaveMarkup(): void {
    if (hydrating || closed || draftDead) return
    persistShotIfChanged() // a crop replaces the backdrop, and its only outside signal is the canvas resizing
    const sig = primSig()
    if (sig === lastPrimSig) return
    lastPrimSig = sig
    persist()
  }

  const openTextInput = (clientX: number, clientY: number) => {
    pendingText = { x: clientX, y: clientY }
    tin.style.left = Math.min(clientX, window.innerWidth - 300) + 'px'
    tin.style.top = Math.min(clientY + 10, window.innerHeight - 92) + 'px'
    tin.style.display = 'flex'
    // A caret dot marks exactly where the text will anchor on the image.
    tmark.style.left = clientX + 'px'; tmark.style.top = clientY + 'px'; tmark.style.display = 'block'
    tinInput.value = ''
    // Defer focus past the current pointer event — focusing during pointerdown (esp. with capture) is flaky.
    setTimeout(() => { tinInput.focus(); tinInput.select() }, 0)
  }
  const hideTextInput = () => { tin.style.display = 'none'; tmark.style.display = 'none' }
  const commitTextInput = () => {
    const s = tinInput.value
    hideTextInput()
    if (pendingText && s.trim()) ann.addText(pendingText.x, pendingText.y, s)
    pendingText = null
  }
  const cancelTextInput = () => { hideTextInput(); pendingText = null }

  const ann = new ImageAnnotator(canvas, { onChange: refresh, onTextRequest: openTextInput })

  // Put the draft back, or start clean. The RESTORED backdrop wins over the screenshot just taken: it is the
  // frame the markup was drawn on, and moving that markup onto a different picture would have it point at the
  // wrong things.
  const restored = hasContent(draft) ? draft : null
  void (async () => {
    const base = restored?.shot?.dataUrl || shot
    let loaded = true
    try { await ann.setImage(base) } catch { loaded = false }
    if (restored?.prims.length) ann.setPrims(restored.prims as Prim[])
    hydrating = false
    refresh()
    lastShotDims = `${canvas.width}x${canvas.height}`
    lastPrimSig = primSig()
    if (!loaded) setMsg('Could not load screenshot', 'err')
    if (restored) {
      updateClipPanel() // a restored video has to reappear in the "attach the recording?" block
      showRestoreBar(restored)
      // Reopened by hand after an Esc: mark the draft live again, so the NEXT reload brings the overlay back
      // on its own instead of making the tester notice and reopen it a second time.
      persist({ open: true })
    } else {
      // A brand-new capture is worth keeping from its first second, not from the first edit.
      persist({ shot: { dataUrl: ann.toBaseDataURL(0.85) } })
    }
  })()

  // Russian counts: 1 пометка / 2 пометки / 5 пометок. Getting this wrong in the one line that tells a tester
  // their work is safe reads as sloppiness exactly where trust is being asked for.
  const plural = (n: number, one: string, few: string, many: string): string => {
    const m10 = n % 10
    const m100 = n % 100
    if (m10 === 1 && m100 !== 11) return one
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
    return many
  }
  const restBar = q<HTMLElement>('.rest')
  const restT = q<HTMLElement>('.restt')
  function showRestoreBar(d: Draft): void {
    const bits: string[] = []
    if (d.prims.length) bits.push(`<b>${d.prims.length}</b> ${plural(d.prims.length, 'пометка', 'пометки', 'пометок')}`)
    if (d.note.trim()) bits.push('заметка')
    if (d.video) bits.push(`видео ${fmtT(d.video.seconds)}`)
    const atts = draftAttachments
      ? ` · <b>${draftAttachments}</b> ${plural(draftAttachments, 'вложение', 'вложения', 'вложений')} — только в окне ⇗`
      : ''
    restT.innerHTML = `↩ Черновик восстановлен — ${bits.join(', ')}${atts}`
    restBar.classList.add('on')
  }

  // The only way to throw restored work away deliberately. Autosave is frozen for the duration, so the reset
  // cannot race the delete and re-create the draft it is removing.
  async function startOver(): Promise<void> {
    draftDead = true
    restBar.classList.remove('on')
    note.value = ''
    type = 'bug'
    severity = 'med'
    syncTypeSev()
    video = null
    attach = true
    trim = null
    ann.clearAll()
    if (openingShot) { try { await ann.setImage(openingShot) } catch {} }
    refresh()
    updateClipPanel()
    await clearDraft(origin)
    draftDead = false // from here the fresh capture is persisted again — it is work too
    lastShotDims = ''
    lastPrimSig = primSig()
    persistShotIfChanged()
    setMsg('Черновик удалён — начинаем заново')
  }
  q<HTMLElement>('.restx').addEventListener('click', () => { void startOver() })

  // Typing is the one change frequent enough to need the debounce; everything else saves immediately.
  note.addEventListener('input', () => persist({}, false))

  // Tool cursor — a live SVG glyph following the pointer, so the pixel under the cursor tells you which tool
  // is armed. System cursor is hidden (see .canvas { cursor: none }) and this element carries the identity.
  const tcur = q<HTMLElement>('.tcur')
  function paintCursor() {
    const t = ann.tool
    tcur.dataset.tool = t
    if (t === 'eraser') { tcur.classList.remove('on'); return }
    tcur.innerHTML = TOOL_CURSORS[t as Exclude<Tool, 'eraser'>]
  }
  paintCursor()

  canvas.addEventListener('pointerenter', () => { if (ann.tool !== 'eraser') tcur.classList.add('on') })
  canvas.addEventListener('pointerleave', () => { tcur.classList.remove('on'); ann.pointerUp() })
  canvas.addEventListener('pointerdown', (e) => {
    // Text & eraser are single-click actions — capturing the pointer here would steal focus from the text input.
    if (ann.tool !== 'text' && ann.tool !== 'eraser') canvas.setPointerCapture(e.pointerId)
    ann.pointerDown(e.clientX, e.clientY)
  })
  canvas.addEventListener('pointermove', (e) => {
    tcur.style.left = e.clientX + 'px'
    tcur.style.top = e.clientY + 'px'
    ann.pointerMove(e.clientX, e.clientY)
  })
  canvas.addEventListener('pointerup', () => ann.pointerUp())

  tinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTextInput() }
    else if (e.key === 'Escape') { e.preventDefault(); cancelTextInput() }
  })
  tinInput.addEventListener('blur', commitTextInput)

  // Colour + width sliders — click to pick, drag to scrub. Each slider snaps to its notches, so the palette
  // still reads as a real set of choices and not a fuzzy continuum.
  const cbar = q<HTMLElement>('.cbar')
  const cknob = q<HTMLElement>('.cknob')
  const wbar = q<HTMLElement>('.wbar')
  const wknob = q<HTMLElement>('.wknob')

  const cbarPick = (x: number) => {
    const r = cbar.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)))
    const i = Math.min(DEFAULT_COLORS.length - 1, Math.floor(t * DEFAULT_COLORS.length))
    pickColor(DEFAULT_COLORS[i]!)
  }
  const wbarPick = (x: number) => {
    const r = wbar.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)))
    pickWidth(t < 0.34 ? 'thin' : t < 0.67 ? 'med' : 'thick')
  }

  // Pointer capture makes the knob follow the finger past the slider's own edges (and past its element for
  // mouse users) — same reliability as native <input type=range>.
  function bindSlider(bar: HTMLElement, onPick: (x: number) => void) {
    bar.addEventListener('pointerdown', (e) => {
      bar.setPointerCapture(e.pointerId)
      onPick(e.clientX)
      const move = (ev: PointerEvent) => onPick(ev.clientX)
      const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up) }
      bar.addEventListener('pointermove', move)
      bar.addEventListener('pointerup', up)
      bar.addEventListener('pointercancel', up)
    })
  }
  bindSlider(cbar, cbarPick)
  bindSlider(wbar, wbarPick)

  // Hotkey layout picker in the tools header.
  const lytBtn = q<HTMLElement>('.lytbtn')
  const lytPop = q<HTMLElement>('.lytpop')
  const lytName = q<HTMLElement>('.lytname')
  function syncLayoutUI() {
    lytName.textContent = layout
    root.querySelectorAll('.lyto').forEach((el) => el.classList.toggle('on', (el as HTMLElement).dataset.lyt === layout))
    TOOL_CODES = TOOL_LAYOUTS[layout]
    WIDTH_CODES = WIDTH_LAYOUTS[layout]
    // Rewrite tool tooltips so hovering shows the CURRENT layout's key, not a stale one.
    const keyFor = (t: Tool) => Object.entries(TOOL_CODES).find(([, v]) => v === t)?.[0]?.replace(/^Key|^Digit/, '') || '—'
    root.querySelectorAll('.tb.tool').forEach((el) => {
      const t = (el as HTMLElement).dataset.tool as Tool
      ;(el as HTMLElement).title = `${TOOL_LABELS[t]} · ${keyFor(t)}`
    })
  }
  lytBtn.addEventListener('click', (e) => { e.stopPropagation(); lytPop.classList.toggle('on') })
  root.querySelectorAll('.lyto').forEach((el) =>
    el.addEventListener('click', () => {
      setLayout((el as HTMLElement).dataset.lyt as 'designer' | 'gamer')
      lytPop.classList.remove('on')
    }),
  )
  root.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest?.('.lyt')) lytPop.classList.remove('on') })
  syncLayoutUI()
  root.querySelectorAll('.tb.tool').forEach((el) =>
    el.addEventListener('click', () => ann.setTool((el as HTMLElement).dataset.tool as Tool)),
  )
  root.querySelectorAll('.seg.type button').forEach((el) =>
    el.addEventListener('click', () => {
      type = (el as HTMLElement).dataset.v as ReportType
      root.querySelectorAll('.seg.type button').forEach((b) => b.classList.toggle('on', b === el))
      syncTitle()
      persist()
    }),
  )
  root.querySelectorAll('.seg.sev button').forEach((el) =>
    el.addEventListener('click', () => {
      severity = (el as HTMLElement).dataset.v as Severity
      root.querySelectorAll('.seg.sev button').forEach((b) => b.classList.toggle('on', b === el))
      persist()
    }),
  )
  root.querySelectorAll('.tinsz button').forEach((el) => {
    el.addEventListener('mousedown', (e) => e.preventDefault()) // keep the text input focused when picking a size
    el.addEventListener('click', () => {
      ann.setTextSize((el as HTMLElement).dataset.tsz as Width)
      root.querySelectorAll('.tinsz button').forEach((b) => b.classList.toggle('on', b === el))
    })
  })
  undoBtn.addEventListener('click', () => ann.undo())
  redoBtn.addEventListener('click', () => ann.redo())
  clearBtn.addEventListener('click', () => ann.clearAll())
  q<HTMLElement>('.x').addEventListener('click', close) // ✕ and Esc keep the draft; only Cancel discards it
  q<HTMLElement>('.cancel').addEventListener('click', () => {
    const hasWork = !!(note.value.trim() || ann.getPrims().length || video || draftAttachments)
    const lost = 'Заметка, пометки и видео' + (draftAttachments ? `, а также ${draftAttachments} ${plural(draftAttachments, 'вложение', 'вложения', 'вложений')} из окна редактора,` : '')
    if (hasWork && !confirm(`Закрыть и удалить черновик? ${lost} будут потеряны.\n\nЧтобы просто свернуть и вернуться позже — Esc.`)) return
    draftDead = true
    void clearDraft(origin)
    close()
  })
  recBtn.addEventListener('click', () => { void recordRepro() })
  reshotBtn.addEventListener('click', () => { void reshoot() })
  // The escape hatch for a report that is turning out long: everything moves to a window the site cannot
  // touch. The background hands the work over (TH_ED_TAKEOVER above) and closes this overlay itself, so the
  // note, the markup, the recording and the taxonomy travel through the draft with nothing left behind.
  q<HTMLElement>('.toed').addEventListener('click', () => {
    if (activeRec) { setMsg('Сначала остановите запись', 'warn'); return }
    setMsg('Переношу в отдельное окно…')
    void chrome.runtime
      .sendMessage({ type: 'TH_EDITOR_OPEN', fresh: false })
      .then((r) => { if (!r?.ok) setMsg('Окно редактора не открылось: ' + (r?.error || 'нет ответа'), 'err') })
      .catch((e) => setMsg('Окно редактора не открылось: ' + String(e), 'err'))
  })

  // Retake the screenshot for THIS report. The overlay steps aside so the page can be arranged (scroll, open a
  // menu, hover something), then one click captures a new frame — the note, the recorded video, the type and
  // the project all stay as they are. Without this the only way to fix a bad frame was to throw the report away
  // and start over.
  async function reshoot() {
    if (closed || activeRec) return
    if (ann.canClear() && !confirm('Разметка относится к текущему кадру и будет удалена. Переснять?')) return

    reshotBtn.disabled = true
    host.style.display = 'none'
    document.removeEventListener('keydown', onKey, true)

    const bar = document.createElement('div')
    bar.className = REPLAY_BLOCK_CLASS
    bar.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 50%; bottom: 26px; transform: translateX(-50%);'
    const broot = bar.attachShadow({ mode: 'open' })
    broot.innerHTML = `<style>${BAR_CSS}</style><div class="bar" style="border-color:#0a84ff"><span class="lbl">Подготовьте страницу и нажмите «Снять»</span><button class="stop" style="background:#0a84ff">📸 Снять (Enter)</button><button class="stop" data-x="1" style="background:#131a2b;border:1px solid #223049">Отмена (Esc)</button></div>`
    document.documentElement.appendChild(bar)

    let done = false
    const finish = () => {
      if (done) return
      done = true
      activeRec = null
      document.removeEventListener('keydown', onShotKey, true)
      bar.remove()
      host.style.display = ''
      document.addEventListener('keydown', onKey, true)
      reshotBtn.disabled = false
    }
    // close() while re-shooting must not leave the bar behind.
    activeRec = () => { if (done) return; done = true; document.removeEventListener('keydown', onShotKey, true); bar.remove() }

    const take = async () => {
      if (done || closed) return
      let shot = ''
      try { const res = await chrome.runtime.sendMessage({ type: 'TH_SHOT' }); if (res?.ok && res.shot) shot = res.shot as string } catch {}
      const ctx = await requestBundle().catch(() => null)
      finish()
      if (closed) return
      if (!shot) { setMsg('Не удалось снять кадр — попробуйте ещё раз', 'err'); return }
      const ok = await ann.setImage(shot).then(() => { refresh(); return true }).catch(() => false)
      if (ctx) context = ctx
      // A re-shoot usually keeps the canvas the same size, so the size-change heuristic would miss it — force
      // the new frame into the draft explicitly.
      if (ok) { lastShotDims = ''; persistShotIfChanged() }
      setMsg(ok ? 'Кадр переснят ✓ — заметка и видео сохранены' : 'Кадр не загрузился', ok ? 'ok' : 'err')
    }
    const onShotKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); setMsg('Пересъёмка отменена') }
      else if (e.key === 'Enter') { e.preventDefault(); void take() }
    }
    document.addEventListener('keydown', onShotKey, true)
    broot.querySelectorAll('.stop').forEach((b) =>
      b.addEventListener('click', () => {
        if ((b as HTMLElement).dataset.x) { finish(); setMsg('Пересъёмка отменена') }
        else void take()
      }),
    )
  }

  // Explicit repro recording: hide this modal so the tester can reproduce the bug on the live page while a
  // floating bar records; Stop → fresh screenshot + attach the clip. Uses a DEDICATED recorder (its own
  // FullSnapshot + an unbroken mutation stream), so the clip is self-contained by construction — it cannot end
  // up as the frozen-frame-with-moving-cursor that slicing a ring buffer produced.
  async function recordRepro() {
    if (closed || activeRec) return
    recBtn.disabled = true

    // Record the tab as VIDEO. A DOM replay reconstructs markup, which for app-heavy pages plays back as
    // "some other layer of the site plus a moving cursor" — useless for behavioural bugs. This records pixels.
    const cfgForVideo = await getConfig()
    const started = await chrome.runtime.sendMessage({ type: 'TH_VIDEO_START', maxSeconds: 300, collectorUrl: cfgForVideo.collectorUrl }).catch((e) => ({ ok: false, error: String(e) }))
    if (!started?.ok) {
      setMsg('Не удалось начать запись экрана: ' + (started?.error || 'нет доступа к вкладке'), 'err')
      recBtn.disabled = false
      return
    }

    host.style.display = 'none' // free the page for interaction; keep this overlay instance to reuse on Stop
    document.removeEventListener('keydown', onKey, true)

    const bar = document.createElement('div')
    bar.className = REPLAY_BLOCK_CLASS
    bar.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 50%; bottom: 26px; transform: translateX(-50%);'
    const broot = bar.attachShadow({ mode: 'open' })
    broot.innerHTML = `<style>${BAR_CSS}</style><div class="bar"><span class="dot"></span><span class="lbl">Запись репро — воспроизведите баг</span><span class="tm">0:00</span><button class="stop">⏹ Стоп (Esc)</button></div>`
    document.documentElement.appendChild(bar)

    const tmEl = broot.querySelector('.tm') as HTMLElement
    const t0 = Date.now()
    const iv = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); tmEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }, 250)

    let done = false
    const teardown = () => {
      clearInterval(iv)
      document.removeEventListener('keydown', onBarKey, true)
      bar.remove()
    }
    // close() during a recording routes here: stop the tab recording, drop the bar, leave nothing behind.
    activeRec = () => { if (done) return; done = true; teardown(); void chrome.runtime.sendMessage({ type: 'TH_VIDEO_STOP' }).catch(() => {}) }

    const onBarKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); void stop() } }
    const stop = async () => {
      if (done || closed) return
      done = true
      activeRec = null
      teardown()

      const res = await chrome.runtime.sendMessage({ type: 'TH_VIDEO_STOP' }).catch((e) => ({ ok: false, error: String(e) }))
      let freshShot = ''
      try { const s = await chrome.runtime.sendMessage({ type: 'TH_SHOT' }); if (s?.ok && s.shot) freshShot = s.shot as string } catch {}
      const ctx = await requestBundle().catch(() => null)
      if (closed) return // the tester closed the overlay while we were awaiting — never resurrect it

      let shotOk = false
      // Keep the tester's markup: they may have annotated BEFORE going off to record the repro.
      if (freshShot) shotOk = await ann.setImage(freshShot, true).then(() => { refresh(); return true }).catch(() => false)
      if (ctx) context = ctx // end-of-repro context: the trail/console/net now includes the reproduction

      host.style.display = ''
      document.addEventListener('keydown', onKey, true)

      if (shotOk) { lastShotDims = ''; persistShotIfChanged() } // the repro's closing frame belongs in the draft

      if (res?.ok && res.url) {
        video = { url: res.url as string, seconds: Number(res.seconds || 0), bytes: Number(res.bytes || 0), capped: !!res.capped, frames: Array.isArray(res.frames) ? res.frames : [] }
        attach = true
        persist() // a finished recording is the most expensive thing in the report — save it before anything else can go wrong
        updateClipPanel()
        const dur = fmtDur(video.seconds)
        const mb = (video.bytes / 1e6).toFixed(1)
        // If the recorder auto-stopped at the size cap, say so — the tester expected it to run longer.
        const cappedNote = video.capped ? ' — обрезано на лимите 38 МБ (5 мин записи ≈ 30 МБ)' : ''
        setMsg(
          shotOk ? `Видео записано: ${dur} · ${mb} МБ ✓ — допишите заметку и Send${cappedNote}`
                 : `Видео записано: ${dur} · ${mb} МБ ✓ (скриншот не обновился)${cappedNote}`,
          video.capped ? 'warn' : 'ok',
        )
      } else {
        setMsg('Запись не получилась: ' + (res?.error || 'пустой файл'), 'err')
        updateClipPanel()
      }
      recBtn.disabled = false
    }
    document.addEventListener('keydown', onBarKey, true)
    ;(broot.querySelector('.stop') as HTMLElement).addEventListener('click', () => { void stop() })
  }

  // Populate the project picker from the account's projects (fetched via background → collector), preselecting
  // the ingest key's own project. Choosing another routes the report there on send.
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  getConfig()
    .then(async (cfg) => {
      const res = (await chrome.runtime.sendMessage({ type: 'TH_PROJECTS', collectorUrl: cfg.collectorUrl, ingestKey: cfg.ingestKey })) as
        { ok?: boolean; projects?: { id: string; name: string }[]; defaultId?: string }
      if (!res?.ok || !Array.isArray(res.projects) || !res.projects.length) return
      // Preference order: the restored draft's own choice (the tester already decided where this report goes)
      // → the project used last (if it still exists) → the ingest key's own → the first one.
      const fromDraft = projectId && res.projects.some((p) => p.id === projectId) ? projectId : ''
      const remembered = res.projects.some((p) => p.id === cfg.lastProjectId) ? cfg.lastProjectId : ''
      projectId = fromDraft || remembered || res.defaultId || res.projects[0]!.id
      psel.innerHTML = res.projects.map((p) => `<option value="${esc(p.id)}"${p.id === projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
    })
    .catch(() => {})
  psel.addEventListener('change', () => {
    projectId = psel.value || null
    if (projectId) void setConfig({ lastProjectId: projectId }) // remembered for the next report
    persist()
  })

  function setMsg(t: string, cls = '') { msg.textContent = t; msg.className = 'msg ' + cls }

  sendBtn.addEventListener('click', async () => {
    // This overlay cannot carry the attachments the editor window collected. Sending from here would file the
    // ticket without them and then clear the draft — losing them for good. Say it before, not after.
    if (
      draftAttachments &&
      !confirm(
        `В черновике ${draftAttachments} ${plural(draftAttachments, 'вложение', 'вложения', 'вложений')}. ` +
        'Они видны только в отдельном окне (⇗ Открыть в окне) и в этот тикет НЕ попадут.\n\n' +
        'Отправить без них?',
      )
    ) return
    const cfg = await getConfig()

    // Prepare the recording FIRST, so its real numbers (raw size, compressed size, why it was dropped) can ride
    // in the report's diagnostics. Previously diag was built before this and could only say "a clip existed",
    // which is exactly the gap that made "sometimes it doesn't save the screencast" un-diagnosable.
    // A recorded video supersedes the DOM buffer: shipping both wastes megabytes and the DOM one is precisely
    // the artefact that plays back without the page's content.
    const sel = video ? { events: [] as RREvent[], trim: undefined } : selectedClip()
    const replay = sel.events
    let replayPayload: RREvent[] | undefined
    let replayGz: string | undefined
    let replayWarn = ''
    let replayBytes = 0
    let gzBytes = 0
    let gzErr = ''
    if (replay.length > 1) {
      const json = JSON.stringify(replay)
      replayBytes = json.length
      const gz = await gzipToBase64(json)
      gzBytes = gz.length
      if (!gz) gzErr = 'compression unavailable'
      // Size is the only hard reason to drop a clip; gzip keeps real recordings far below the cap.
      if (gz && gz.length < 24_000_000) replayGz = gz
      else if (!gz && replayBytes < 4_000_000) replayPayload = replay
      else replayWarn = `запись не приложена (${Math.round(replayBytes / 1e6)} МБ — слишком большая)`
    }

    const payload = buildReport({
      ingestKey: cfg.ingestKey,
      note: note.value,
      type,
      severity,
      // JPEG by default keeps full-page screenshots small; core also exposes a PNG option (toDataURL(q,
      // 'image/png') / toPNG()) for crisp line/dark-palette annotations when payload size isn't a concern.
      screenshot: ann.toDataURL(0.85),
      pageUrl: location.href,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      userAgent: navigator.userAgent,
      // Always carry the recorder's self-report, and keep the bundle even when the MAIN-world probe is absent
      // (a tab that outlived an extension reload) so a context-less report still says WHY it is context-less.
      context: {
        ...(context ?? {}),
        diag: {
          ...recorderDiag(),
          bridge: !!context,
          // `caps` identifies the build, so a report from a stale extension is obvious instead of looking like
          // a server-side loss; probeAge says whether the MAIN-world probe started late (a tab injected after
          // an extension reload misses the console output the app produced while loading).
          caps: 'gz+trim+clip+cmt',
          extVersion: chrome.runtime.getManifest?.().version ?? '?',
          probeAge: (context as { probeAge?: number } | null)?.probeAge ?? null,
          clipSpan: Math.round(spanOf(replay)),
          attach,
          trimmed: !!sel.trim,
          replayBytes,
          gzBytes,
          gzErr: gzErr || null,
          dropped: replayWarn || null,
        },
      } as typeof context,
      projectId,
    })
    if (!payload.note && !payload.screenshot) { setMsg('Add a note or a screenshot', 'err'); return }
    sendBtn.disabled = true
    setMsg('Sending…')
    try {
      // Replay events ride alongside the report (they're large → the collector stores them as a blob, not
      // in the report row). Evaluated at SEND (auto) or the frozen explicit clip. A clip that wouldn't play or
      // that blows the size cap is dropped — but never silently: the tester is told, because "I recorded it and
      // it isn't there" is the single worst failure this tool can have.
      if (replayWarn) setMsg(`⚠ ${replayWarn}`, 'warn')
      const res = await chrome.runtime.sendMessage({
        type: 'TH_SEND',
        collectorUrl: cfg.collectorUrl,
        payload: {
          ...payload,
          replay: replayPayload,
          replayGz,
          replayEvents: replay.length,
          replayBytes,
          replayTrim: sel.trim,
          // The recorded tab video, when there is one — already webm-compressed, sent as-is.
          // The offscreen recorder already uploaded the video and gave us its URL — hand that to the collector
          // instead of the megabytes. `video` (data URL) stays supported by the endpoint for older builds.
          videoUrl: attach && video ? video.url : undefined,
          videoSeconds: attach && video ? Math.round(video.seconds) : undefined,
          // The stretch chosen in the editor — the dashboard plays exactly this, so the reader sees the moment
          // that matters instead of the whole run-up.
          videoTrim: attach && video && trim ? { from: trim.from, to: trim.to } : undefined,
          // Stills sampled from the recording. An agent cannot watch a video, so these are what it actually
          // looks at; timestamps let it line them up with the steps and the console/network trail.
          videoFrames: attach && video?.frames?.length ? video.frames : undefined,
        },
      })
      if (res?.ok) {
        // The server has it: this is the one and only moment the draft may be thrown away automatically.
        draftDead = true
        void clearDraft(origin)
        // Never let a green "sent" paper over a dropped recording — the tester must know what actually landed.
        if (replayWarn) setMsg(`Отправлено, но ${replayWarn}`, 'warn')
        else if (replayGz || replayPayload) setMsg(`Отправлено ✓ (запись ${fmtDur(sel.trim ? sel.trim.to - sel.trim.from : spanOf(replay))})`, 'ok')
        else setMsg(attach ? 'Отправлено ✓ (без записи)' : 'Отправлено ✓ (запись не приложена — по вашему выбору)', 'ok')
        setTimeout(close, replayWarn ? 2600 : 1100)
      } else { setMsg('Failed: ' + (res?.error || 'server error'), 'err'); sendBtn.disabled = false }
    } catch (e) {
      setMsg('Failed: ' + String(e), 'err'); sendBtn.disabled = false
    }
  })
}
