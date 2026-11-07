// M0 test 7: the file changes between the debounce and the save -> no overwrite, conflict/freeze emitted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpDir, startHost, client, synced, waitFor } from './helpers.js'
import { FileStore } from '../src/core/FileStore.js'

test('FileStore: change during debounce window -> CAS refuses to write', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'doc.md')
  await fs.writeFile(file, 'original\n')
  const store = await FileStore.open(file, { backupRoot: path.join(dir, 'b'), debounceMs: 200 })
  const conflicts = []
  store.on('conflict', e => conflicts.push(e))

  store.scheduleSave('ours\n')
  await fs.writeFile(file, 'theirs\n') // in-place external write inside the debounce window
  await store.flush()

  assert.equal(await fs.readFile(file, 'utf8'), 'theirs\n')
  assert.deepEqual(conflicts, [{ reason: 'changed' }])
  // stays refused: later saves never clobber the external version
  assert.equal(await store.save('ours again\n'), false)
  assert.equal(await fs.readFile(file, 'utf8'), 'theirs\n')
})

test('FileStore: file deleted before save -> no recreate, conflict "missing"', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'doc.md')
  await fs.writeFile(file, 'original\n')
  const store = await FileStore.open(file, { backupRoot: path.join(dir, 'b') })
  const conflicts = []
  store.on('conflict', e => conflicts.push(e))
  await fs.rm(file)
  assert.equal(await store.save('ours\n'), false)
  await assert.rejects(fs.stat(file), { code: 'ENOENT' })
  assert.deepEqual(conflicts, [{ reason: 'missing' }])
})

test('Host: save race freezes the session and later client edits are dropped', async () => {
  const ctx = await startHost({ content: 'original\n', debounceMs: 300 })
  const c = client(ctx)
  try {
    await synced(c)
    // stop the watcher so this test isolates the CAS path (watcher is covered by test 8)
    ctx.host.watcher.stop()
    c.text.insert(0, 'edit ')
    await waitFor(() => ctx.host.session.text.startsWith('edit '), { label: 'edit reached server' })
    await fs.writeFile(ctx.file, 'external\n')
    await ctx.host.store.flush()
    assert.equal(ctx.host.session.frozen, true)
    assert.equal(await fs.readFile(ctx.file, 'utf8'), 'external\n')

    c.text.insert(0, 'more ')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(!ctx.host.session.text.includes('more'), 'frozen session drops updates')
  } finally {
    c.close()
    await ctx.host.close()
  }
  assert.equal(await fs.readFile(ctx.file, 'utf8'), 'external\n', 'stop/flush never overwrites')
})
