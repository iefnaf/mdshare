// M0 test 1: 3 clients, 1000 random edits with random disconnects -> all texts equal,
// and the disk file equals the text after a flush.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { startHost, client, synced, waitFor, rng } from './helpers.js'

// BMP only: random UTF-16 offsets could split a surrogate pair, which is a client-side
// editor concern (CodeMirror never does that), not a sync-server one.
const ALPHABET = [...'abcdefghij KLM\n#*-é漢']

test('convergence: 3 clients x 1000 random edits with random disconnects', { timeout: 60_000 }, async () => {
  const seed = Number(process.env.MDSHARE_SEED ?? Date.now() % 1e9)
  const rand = rng(seed)
  const ctx = await startHost()
  const clients = [client(ctx), client(ctx), client(ctx)]
  try {
    await Promise.all(clients.map(synced))

    for (let i = 0; i < 1000; i++) {
      const c = clients[Math.floor(rand() * clients.length)]
      const len = c.text.length
      if (len > 0 && rand() < 0.35) {
        const at = Math.floor(rand() * len)
        c.text.delete(at, Math.min(len - at, 1 + Math.floor(rand() * 5)))
      } else {
        const at = Math.floor(rand() * (len + 1))
        const ch = ALPHABET[Math.floor(rand() * ALPHABET.length)]
        c.text.insert(at, ch.repeat(1 + Math.floor(rand() * 3)))
      }
      if (rand() < 0.02) {
        const d = clients[Math.floor(rand() * clients.length)]
        if (d.provider.wsconnected) d.provider.disconnect()
        else d.provider.connect()
      }
      if (i % 20 === 0) await new Promise(resolve => setTimeout(resolve, 1))
    }

    for (const c of clients) if (!c.provider.shouldConnect) c.provider.connect()
    const server = () => ctx.host.session.text
    await waitFor(() => clients.every(c => c.provider.wsconnected && c.text.toString() === server()), {
      timeout: 20_000,
      label: `convergence (seed ${seed})`
    })

    await ctx.host.store.flush()
    const disk = await fs.readFile(ctx.file, 'utf8')
    assert.equal(disk, server(), `disk == doc (seed ${seed})`)
    assert.ok(server().length > 0)
  } finally {
    clients.forEach(c => c.close())
    await ctx.host.close()
  }
})
