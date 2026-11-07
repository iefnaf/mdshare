// M0 test 2: 5 clients join an existing document; content is not duplicated (G1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHost, client, synced, waitFor } from './helpers.js'

test('seeding: server seeds once, 5 joining clients see exactly the file content', async () => {
  const content = '# Title\n\nSome *markdown* with ünïcode 漢字.\n'
  const ctx = await startHost({ content })
  const clients = []
  try {
    for (let i = 0; i < 5; i++) {
      const c = client(ctx)
      clients.push(c)
      await synced(c)
    }
    await waitFor(() => clients.every(c => c.text.toString() === content), { label: 'all clients synced' })
    assert.equal(ctx.host.session.text, content)
    for (const c of clients) assert.equal(c.text.toString(), content)

    // A client joining after edits gets the edited text, still once.
    clients[0].text.insert(0, 'X')
    const late = client(ctx)
    clients.push(late)
    await synced(late)
    await waitFor(() => late.text.toString() === 'X' + content, { label: 'late joiner' })
    assert.equal(ctx.host.session.text, 'X' + content)
  } finally {
    clients.forEach(c => c.close())
    await ctx.host.close()
  }
})
