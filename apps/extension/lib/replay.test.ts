import assert from 'node:assert/strict'
import { sliceRecentEvents, type RREvent } from './replay'

const META = 4
const FULL = 2
const INC = 3
const e = (type: number, ts: number): RREvent => ({ type, timestamp: ts })

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

console.log('extension: replay buffer tests passed ✓')
