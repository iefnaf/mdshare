// M0 test 3: after a new epoch, an old-epoch client gets 4001 and its content never
// reaches the new document. After Stop + new share, the old link gets 401.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHost, client, synced, waitFor, rawUpgrade } from './helpers.js'
import { CLOSE } from '../src/core/SyncServer.js'

test('epoch: reload closes live clients with 4001 and stale edits never resurrect', async () => {
  const ctx = await startHost({ content: 'base\n' })
  const live = client(ctx)
  const stale = client(ctx)
  try {
    await Promise.all([synced(live), synced(stale)])
    const oldEpoch = ctx.host.session.epoch

    // stale client goes offline and keeps editing locally
    stale.provider.disconnect()
    stale.text.insert(0, 'STALE-')

    ctx.host.session.reload('fresh from disk\n')
    assert.notEqual(ctx.host.session.epoch, oldEpoch)
    await waitFor(() => live.closes.includes(CLOSE.STALE_EPOCH), { label: 'live client 4001' })

    // stale reconnects with its old epoch (same token): must be closed with 4001
    stale.provider.connect()
    await waitFor(() => stale.closes.includes(CLOSE.STALE_EPOCH), { label: 'stale client 4001' })
    await new Promise(resolve => setTimeout(resolve, 100))

    assert.equal(ctx.host.session.text, 'fresh from disk\n')
    assert.ok(!ctx.host.session.text.includes('STALE'))
    assert.equal(ctx.host.server.conns.size, 0)

    // a client on the new epoch syncs normally
    const fresh = client(ctx)
    await synced(fresh)
    await waitFor(() => fresh.text.toString() === 'fresh from disk\n', { label: 'fresh client' })
    fresh.close()
  } finally {
    live.close()
    stale.close()
    await ctx.host.close()
  }
})

test('stop sharing: clients closed with 4000, old token gets 401, next share has new token+epoch', async () => {
  const ctx = await startHost()
  const c = client(ctx)
  try {
    await synced(c)
    const old = { token: ctx.host.session.editToken, epoch: ctx.host.session.epoch }
    await ctx.host.stopSharing()
    await waitFor(() => c.closes.includes(CLOSE.STOPPED), { label: '4000 on stop' })
    c.close()

    const res = await rawUpgrade(ctx.port, { path: `/ws?e=${old.epoch}&t=${old.token}`, origin: ctx.origin })
    assert.equal(res.status, 401)
    assert.equal(res.upgraded, false)

    const next = await ctx.host.shareFile(ctx.file)
    assert.notEqual(next.editToken, old.token)
    assert.notEqual(next.epoch, old.epoch)
    const again = await rawUpgrade(ctx.port, { path: `/ws?e=${old.epoch}&t=${old.token}`, origin: ctx.origin })
    assert.equal(again.status, 401)
  } finally {
    c.close()
    await ctx.host.close()
  }
})
