// G5: the suite must run on Electron's embedded Node (npm test), not system Node.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('running under Electron (ELECTRON_RUN_AS_NODE)', { skip: process.env.MDSHARE_ALLOW_SYSTEM_NODE === '1' }, () => {
  assert.ok(process.versions.electron, `expected Electron runtime, got node ${process.version}`)
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
})
