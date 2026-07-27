import assert from 'node:assert/strict'
import { sliceRecentEvents, clipHealth, spanSeconds, trimClip, trimPoints, type RREvent } from './replay'

const META = 4
const FULL = 2
const INC = 3
const e = (type: number, ts: number): RREvent => ({ type, timestamp: ts })

// Builders for the health check: a snapshot holding node ids 1..n, and mutations addressing given ids.
const snapEvent = (ids: number[], ts = 0): RREvent => ({
  type: FULL,
  timestamp: ts,
  data: { node: { id: ids[0], childNodes: ids.slice(1).map((id) => ({ id, childNodes: [] })) } },
})
const mutation = (refs: number[], ts: number): RREvent => ({
  type: INC,
  timestamp: ts,
  data: { source: 0, texts: refs.map((id) => ({ id })), attributes: [], removes: [], adds: [] },
})

// 1. Window keeps only the last 3 segments and re-anchors to a Meta+FullSnapshot pair so a Replayer can boot.
{
  const matrix: RREvent[][] = [
    [e(META, 0), e(FULL, 0), e(INC, 1)], // seg0 (should be dropped by KEEP_SEGMENTS=3? there are 4 segs)
    [e(FULL, 60), e(INC, 61)], // seg1 headed by bare FullSnapshot (its Meta is in seg0 tail)
    [e(META, 120), e(FULL, 120), e(INC, 121)], // seg2 clean pair
    [e(FULL, 180), e(INC, 181)], // seg3 bare
  ]
  const out = sliceRecentEvents(matrix)
  assert.equal(out[0]!.type, META, 'starts at a Meta')
  assert.equal(out[1]!.type, FULL, 'Meta immediately followed by FullSnapshot')
  // slice(-3) = seg1,seg2,seg3; first Meta+Full pair is seg2's → boots there
  assert.equal(out[0]!.timestamp, 120, 're-anchored to the clean pair in the window')
}

// 2. Fallback: a lone FullSnapshot with no preceding Meta still boots from the FullSnapshot.
{
  const out = sliceRecentEvents([[e(INC, 1), e(FULL, 2), e(INC, 3)]])
  assert.equal(out[0]!.type, FULL, 'boots from the FullSnapshot')
  assert.equal(out.length, 2)
}

// 3. No full snapshot anywhere → not replayable → empty (caller must skip attaching).
{
  assert.deepEqual(sliceRecentEvents([[e(INC, 1), e(INC, 2)]]), [], 'no snapshot → empty')
}

// 4. Simple clean case: one segment with a proper head is returned whole.
{
  const seg: RREvent[] = [e(META, 0), e(FULL, 0), e(INC, 1), e(INC, 2)]
  assert.deepEqual(sliceRecentEvents([seg]), seg, 'clean single segment passes through')
}

// 5. clipHealth catches the real-world failure that made replays freeze: a clip whose mutations address nodes
//    the snapshot never contained (snapshot and mutations from different moments). rrweb drops those silently,
//    rendering a still frame with only the cursor moving — so we must refuse to call such a clip playable.
{
  const broken: RREvent[] = [
    e(META, 0),
    snapEvent([1, 2, 3], 0),
    mutation([9001, 9002, 9003], 10),
    mutation([9004, 9005, 9006], 20),
  ]
  const h = clipHealth(broken)
  assert.equal(h.playable, false, 'unresolvable mutations → not playable')
  assert.equal(h.reason, 'mutations_unresolved')
  assert.ok(h.missing > h.resolved, 'majority of refs are missing')
}

// 6. A coherent clip — mutations address nodes from its own snapshot — is playable.
{
  const good: RREvent[] = [e(META, 0), snapEvent([1, 2, 3, 4], 0), mutation([2, 3], 10), mutation([4], 20)]
  const h = clipHealth(good)
  assert.equal(h.playable, true, 'resolvable mutations → playable')
  assert.equal(h.missing, 0)
}

// 7. Nodes introduced by a mutation become addressable for later mutations (adds then edit).
{
  const withAdds: RREvent[] = [
    e(META, 0),
    snapEvent([1, 2], 0),
    { type: INC, timestamp: 5, data: { source: 0, adds: [{ parentId: 2, node: { id: 50, childNodes: [] } }], texts: [], attributes: [], removes: [] } },
    mutation([50], 10),
  ]
  assert.equal(clipHealth(withAdds).playable, true, 'ids created mid-clip resolve for later mutations')
}

// 8. A clip that does not boot (no Meta+FullSnapshot head) is rejected outright.
{
  assert.equal(clipHealth([e(INC, 1), e(INC, 2)]).reason, 'no_boot_frame')
  assert.equal(clipHealth([]).reason, 'empty')
}

// 9. spanSeconds reports the wall span of a clip.
{
  assert.equal(spanSeconds([e(META, 1000), e(INC, 4000)]), 3)
  assert.equal(spanSeconds([e(META, 1000)]), 0, 'single event → no span')
}

// 10. Trimming: the right edge is exact, the left edge snaps BACK to a checkpoint so the clip still boots.
{
  // checkpoints at 0s and 30s; events every 10s up to 60s
  const clip: RREvent[] = [
    e(META, 0), snapEvent([1, 2], 0),
    mutation([2], 10_000), mutation([2], 20_000),
    e(META, 30_000), snapEvent([1, 2], 30_000),
    mutation([2], 40_000), mutation([2], 50_000), mutation([2], 60_000),
  ]
  assert.deepEqual(trimPoints(clip), [0, 30], 'checkpoints are the offered cut points')

  // asking to start at 35s snaps back to the 30s checkpoint (never forward — the snapshot must survive)
  const t1 = trimClip(clip, 35, 60)
  assert.equal(t1.from, 30, 'left edge snapped back to the checkpoint')
  assert.equal(t1.events[0]!.type, META, 'trimmed clip still opens on Meta')
  assert.equal(t1.events[1]!.type, FULL, '…followed by its FullSnapshot')
  assert.equal(clipHealth(t1.events).playable, true, 'trimmed clip stays playable')

  // right edge is exact: cutting at 45s drops the 50s and 60s events
  const t2 = trimClip(clip, 30, 45)
  assert.equal(t2.to, 45)
  assert.equal(t2.events.at(-1)!.timestamp, 40_000, 'trailing events past the cut are dropped')

  // trimming to the tail shrinks the payload
  assert.ok(trimClip(clip, 30, 60).events.length < clip.length, 'a tail trim is smaller than the whole clip')

  // full range returns everything, still playable
  const whole = trimClip(clip, 0, 60)
  assert.equal(whole.events.length, clip.length, 'full range keeps every event')
  assert.equal(clipHealth(whole.events).playable, true)
}

console.log('extension: replay buffer tests passed ✓')
