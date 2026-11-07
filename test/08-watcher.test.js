// M0 test 8: an external atomic rename freezes within 1 s; our own saves never freeze.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startHost, client, synced, waitFor } from './helpers.js'

test('watcher: 10 own saves do not freeze', async () => {
  const ctx = await startHost({ content: 'start\n', debounceMs: 20 })
  const c = client(ctx)
  try {
    await synced(c)
    for (let i = 0; i < 10; i++) {
      c.text.insert(c.text.length, `line ${i}\n`)
      await waitFor(() => ctx.host.session.text.includes(`line ${i}\n`), { label: `edit ${i}` })
      await ctx.host.store.flush()
    }
    await new Promise(resolve => setTimeout(resolve, 500)) // let any watcher events settle
    assert.equal(ctx.host.session.frozen, false)
    assert.equal(await fs.readFile(ctx.file, 'utf8'), ctx.host.session.text)
  } finally {
    c.close()
    await ctx.host.close()
  }
})

for (const [label, mutate] of [
  ['atomic rename (VS Code / vim style)', async file => {
    const tmp = path.join(path.dirname(file), '.doc.md.swp')
    await fs.writeFile(tmp, 'external via rename\n')
    await fs.rename(tmp, file)
  }],
  ['in-place write (TextEdit style)', file => fs.writeFile(file, 'external in place\n')],
  ['delete', file => fs.rm(file)],
  ['rename away', file => fs.rename(file, file + '.moved')]
]) {
  test(`watcher: ${label} freezes within 1 s and disk is untouched`, async () => {
    const ctx = await startHost({ content: 'start\n' })
    const frozen = new Promise(resolve => ctx.host.session.once('frozen', resolve))
    try {
      const t0 = Date.now()
      await mutate(ctx.file)
      const reason = await Promise.race([frozen, new Promise(resolve => setTimeout(() => resolve(null), 1000))])
      assert.ok(reason, `froze within 1 s (${Date.now() - t0} ms)`)
      assert.equal(reason.source, 'watch')
      const after = await fs.readFile(ctx.file, 'utf8').catch(() => null)
      await ctx.host.close()
      assert.equal(await fs.readFile(ctx.file, 'utf8').catch(() => null), after, 'stop never overwrites')
    } finally {
      await ctx.host.close()
    }
  })
}
