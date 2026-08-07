import assert from 'node:assert/strict'

// A fake chrome.storage.local — the real one is the only dependency the draft store has, and it is the part
// whose semantics (async, whole-object get, key-list remove) the store must respect exactly.
type Store = Record<string, unknown>
const store: Store = {}
function resetStore(seed: Store = {}): void {
  for (const k of Object.keys(store)) delete store[k]
  Object.assign(store, seed)
}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(keys: string | string[] | null): Promise<Store> {
        if (keys == null) return { ...store }
        const list = Array.isArray(keys) ? keys : [keys]
        const out: Store = {}
        for (const k of list) if (k in store) out[k] = store[k]
        return out
      },
      async set(items: Store): Promise<void> {
        // The real storage serialises what it is given; keeping references here would hide a draft that
        // cannot survive the trip (a canvas element, a DOM node, a function).
        Object.assign(store, JSON.parse(JSON.stringify(items)) as Store)
      },
      async remove(keys: string | string[]): Promise<void> {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
      },
    },
  },
}

const { loadDraft, saveDraft, clearDraft, listDrafts, flushDrafts, draftKey, hasContent, DRAFT_TTL_MS, MAX_DRAFTS, DRAFT_VERSION } =
  await import('./draft')

const A = 'https://a.test'
const B = 'https://b.test'

// A raw stored record, so age can be dictated rather than waited for.
const rec = (origin: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  version: DRAFT_VERSION, origin, pageUrl: origin + '/x', updatedAt, open: false,
  note: '', type: 'bug', severity: 'med', projectId: null,
  shot: null, prims: [], video: null, context: null, ...extra,
})

// 1. Round-trip + shallow merge: separate patches accumulate into one draft rather than replacing it.
{
  resetStore()
  await saveDraft(A, { note: 'кнопка не жмётся' })
  await saveDraft(A, { prims: [{ kind: 'rect' }, { kind: 'arrow' }] })
  await saveDraft(A, { severity: 'crit', shot: { dataUrl: 'data:image/jpeg;base64,AAA' } })
  await flushDrafts()

  const d = await loadDraft(A)
  assert.ok(d, 'draft round-tripped')
  assert.equal(d!.note, 'кнопка не жмётся', 'note survived later patches')
  assert.equal(d!.prims.length, 2, 'primitives survived')
  assert.equal(d!.severity, 'crit')
  assert.equal(d!.shot!.dataUrl.startsWith('data:image/jpeg'), true)
  assert.equal(d!.origin, A, 'origin is stamped by the store, not by the caller')
  assert.equal(d!.version, DRAFT_VERSION)
  assert.ok(d!.updatedAt > 0, 'updatedAt stamped')
  assert.ok(draftKey(A).endsWith(A), 'key is namespaced per origin')
}

// 2. A pending (not yet flushed) patch is visible to loadDraft — the overlay must never read back stale text
//    it just typed, and a reload that beats the debounce is the whole problem this store exists to solve.
{
  resetStore()
  await saveDraft(A, { note: 'первое' })
  await flushDrafts()
  void saveDraft(A, { note: 'второе' }) // deliberately not awaited: still in the debounce window
  const d = await loadDraft(A)
  assert.equal(d!.note, 'второе', 'unflushed patch is merged into the read')
  await flushDrafts()
  assert.equal((await loadDraft(A))!.note, 'второе', 'and it lands in storage')
}

// 3. TTL: a draft older than DRAFT_TTL_MS is ignored AND garbage-collected, so it cannot resurface later.
{
  const stale = Date.now() - DRAFT_TTL_MS - 1000
  resetStore({ [draftKey(A)]: rec(A, stale, { note: 'вчерашнее' }), [draftKey(B)]: rec(B, Date.now(), { note: 'сегодняшнее' }) })
  assert.equal(await loadDraft(A), null, 'stale draft is not returned')
  assert.equal(draftKey(A) in store, false, 'stale draft is removed from storage on read')
  assert.equal((await loadDraft(B))!.note, 'сегодняшнее', 'a fresh draft on another origin is untouched')
}

// 4. listDrafts returns fresh drafts newest-first and sweeps stale ones; foreign keys are never touched.
{
  const now = Date.now()
  resetStore({
    collectorUrl: 'http://localhost:4319', // a config key living in the same storage area
    [draftKey(A)]: rec(A, now - 1000),
    [draftKey(B)]: rec(B, now - 5000),
    [draftKey('https://old.test')]: rec('https://old.test', now - DRAFT_TTL_MS - 1),
  })
  const list = await listDrafts()
  assert.deepEqual(list.map((d) => d.origin), [A, B], 'newest first, stale dropped')
  assert.equal(draftKey('https://old.test') in store, false, 'stale swept')
  assert.equal(store.collectorUrl, 'http://localhost:4319', 'non-draft keys are left alone')
}

// 5. Eviction: a screenshot is megabytes, so the store keeps at most MAX_DRAFTS and drops the oldest.
{
  const now = Date.now()
  const seed: Store = {}
  const origins: string[] = []
  for (let i = 0; i < MAX_DRAFTS; i++) {
    const o = `https://s${i}.test`
    origins.push(o)
    seed[draftKey(o)] = rec(o, now - (MAX_DRAFTS - i) * 10_000) // s0 oldest … last one newest
  }
  resetStore(seed)
  await saveDraft('https://fresh.test', { note: 'новый' })
  await flushDrafts()

  const list = await listDrafts()
  assert.equal(list.length, MAX_DRAFTS, 'never more than the cap')
  assert.ok(list.some((d) => d.origin === 'https://fresh.test'), 'the draft being written always survives')
  assert.ok(!list.some((d) => d.origin === origins[0]), 'the oldest draft was evicted')
  assert.ok(list.some((d) => d.origin === origins[MAX_DRAFTS - 1]), 'newer drafts kept')
}

// 6. clearDraft removes only its own origin — two sites captured in parallel must not clobber each other.
{
  resetStore()
  await saveDraft(A, { note: 'a' })
  await saveDraft(B, { note: 'b' })
  await flushDrafts()
  await clearDraft(A)
  assert.equal(await loadDraft(A), null, 'own origin cleared')
  assert.equal((await loadDraft(B))!.note, 'b', 'other origin intact')
}

// 7. clearDraft also drops a patch still sitting in the debounce buffer — otherwise "Начать заново" would be
//    undone a few hundred milliseconds later by the write it thought it had cancelled.
{
  resetStore()
  void saveDraft(A, { note: 'мусор' }) // still buffered, not yet written
  await clearDraft(A)
  await flushDrafts()
  assert.equal(await loadDraft(A), null, 'pending patch discarded with the draft')
}

// 8. hasContent tells the overlay whether a restored draft is worth announcing: an empty shell is not.
{
  assert.equal(hasContent(rec(A, Date.now()) as never), false, 'blank draft has nothing to restore')
  assert.equal(hasContent(rec(A, Date.now(), { note: 'x' }) as never), true)
  assert.equal(hasContent(rec(A, Date.now(), { prims: [{ kind: 'rect' }] }) as never), true)
  assert.equal(hasContent(rec(A, Date.now(), { video: { url: 'u', seconds: 3, bytes: 1, frames: [] } }) as never), true)
}

// 9. A record written by a future/older schema is not trusted — silently mixing shapes is worse than a fresh start.
{
  resetStore({ [draftKey(A)]: { ...rec(A, Date.now(), { note: 'из другой версии' }), version: DRAFT_VERSION + 1 } })
  assert.equal(await loadDraft(A), null, 'foreign schema version ignored')
  assert.equal(draftKey(A) in store, false, 'and cleaned up')
}

// 10. Attachments (the editor window's strip) round-trip with their own markup and captions, and a record
//     written before the field existed still reads back as an empty list rather than undefined.
{
  resetStore()
  await saveDraft(A, {
    attachments: [
      { id: 'a1', base: 'data:image/jpeg;base64,AAA', prims: [{ kind: 'rect' }], caption: 'первый экран' },
      { id: 'a2', base: 'data:image/jpeg;base64,BBB', prims: [], caption: '' },
    ],
  })
  await flushDrafts()
  const d = await loadDraft(A)
  assert.equal(d!.attachments.length, 2, 'attachments survive the round trip')
  assert.equal(d!.attachments[0]!.caption, 'первый экран', 'captions survive')
  assert.equal(d!.attachments[0]!.prims.length, 1, 'each attachment keeps its OWN markup')
  assert.deepEqual(d!.attachments.map((a) => a.id), ['a1', 'a2'], 'order is preserved — it is the numbering')
  assert.equal(hasContent(d), true, 'an attachment alone is work worth restoring')

  // A draft written by the previous build has no `attachments` key at all.
  resetStore({ [draftKey(B)]: rec(B, Date.now(), { note: 'старый черновик' }) })
  const legacy = await loadDraft(B)
  assert.deepEqual(legacy!.attachments, [], 'a record without the field reads back as an empty list')
}

console.log('extension: draft store tests passed ✓')
