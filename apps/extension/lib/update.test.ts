import assert from 'node:assert/strict'
import { isNewer } from './update'

assert.equal(isNewer('0.2.0', '0.1.0'), true)
assert.equal(isNewer('0.10.0', '0.9.3'), true) // numeric, not string, comparison
assert.equal(isNewer('0.1.0', '0.1.0'), false)
assert.equal(isNewer('0.1.0', '0.2.0'), false)
assert.equal(isNewer('1.0', '0.9.9'), true)
assert.equal(isNewer('0.2.0', '0.2'), false) // missing parts are zeros
console.log('update: ok')
