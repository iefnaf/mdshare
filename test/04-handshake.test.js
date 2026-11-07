// M0 test 4: token/Origin/Host checked before upgrade; oversized frames close with 1009.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startHost, rawUpgrade, waitFor } from './helpers.js'

let ctx
let q
before(async () => {
  ctx = await startHost()
  q = `e=${ctx.session.epoch}&t=${ctx.session.editToken}`
})
after(() => ctx.host.close())

const up = (opts) => rawUpgrade(ctx.port, { origin: ctx.origin, path: `/ws?${q}`, ...opts })

test('valid handshake upgrades (control)', async () => {
  const res = await up({})
  assert.equal(res.upgraded, true)
  assert.equal(res.status, 101)
  res.socket.destroy()
})

test('missing token -> 401, no upgrade', async () => {
  const res = await up({ path: `/ws?e=${ctx.session.epoch}` })
  assert.deepEqual([res.status, res.upgraded], [401, false])
})

test('wrong token -> 401, no upgrade', async () => {
  const res = await up({ path: `/ws?e=${ctx.session.epoch}&t=${'A'.repeat(22)}` })
  assert.deepEqual([res.status, res.upgraded], [401, false])
})

test('foreign Origin -> 403', async () => {
  const res = await up({ origin: 'http://evil.example' })
  assert.deepEqual([res.status, res.upgraded], [403, false])
})

test('missing Origin -> 403', async () => {
  const res = await rawUpgrade(ctx.port, { path: `/ws?${q}` })
  assert.deepEqual([res.status, res.upgraded], [403, false])
})

test('Host: evil.example -> 421 (DNS rebinding)', async () => {
  const res = await up({ host: 'evil.example', origin: 'http://evil.example' })
  assert.deepEqual([res.status, res.upgraded], [421, false])
})

test('Host with wrong port -> 421', async () => {
  const res = await up({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })
  assert.deepEqual([res.status, res.upgraded], [421, false])
})

test('non-/ws upgrade paths -> 404', async () => {
  for (const p of [`/ws/../ws?${q}`, `/wsx?${q}`, `/?${q}`, `/ws/?${q}`]) {
    const res = await up({ path: p })
    assert.deepEqual([p, res.status, res.upgraded], [p, 404, false])
  }
})

test('9th connection -> 503', async () => {
  const sockets = []
  try {
    for (let i = 0; i < 8; i++) {
      const res = await up({})
      assert.equal(res.upgraded, true, `connection ${i + 1}`)
      sockets.push(res.socket)
    }
    await waitFor(() => ctx.host.server.conns.size === 8, { label: '8 conns' })
    const ninth = await up({})
    assert.deepEqual([ninth.status, ninth.upgraded], [503, false])
  } finally {
    sockets.forEach(s => s.destroy())
    await waitFor(() => ctx.host.server.conns.size === 0, { label: 'conns drained' })
  }
})

test('300 KB message -> close 1009', async () => {
  const ws = new WebSocket(`ws://${ctx.hostHeader}/ws?${q}`, { origin: ctx.origin })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const code = await new Promise(resolve => {
    ws.once('close', c => resolve(c))
    ws.send(Buffer.alloc(300 * 1024, 1))
  })
  assert.equal(code, 1009)
  assert.equal(ctx.session.text, '# Hello\n\nworld\n')
})
