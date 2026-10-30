import assert from 'node:assert/strict'
import { shouldReload } from './selfupdate'

assert.equal(shouldReload('0.2.2', '0.2.2', null), false) // nothing changed
assert.equal(shouldReload('0.2.2', '0.2.3', null), false) // first sighting — the copy may still be running
assert.equal(shouldReload('0.2.2', '0.2.3', '0.2.3'), true) // seen twice — the folder settled
assert.equal(shouldReload('0.2.2', '0.2.4', '0.2.3'), false) // still changing under us
assert.equal(shouldReload('0.2.2', null, '0.2.3'), false) // unreadable now — wait
assert.equal(shouldReload('0.2.3', '0.2.2', '0.2.2'), true) // a rollback is a change too
console.log('selfupdate: ok')
