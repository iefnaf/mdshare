import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startHost, client, synced, waitFor, rawUpgrade, get } from './helpers.js'
import { collectShareFiles } from '../src/core/shareFiles.js'
import { TEXT_KEY } from '../src/core/protocol.js'

const textOf = (session, id) => session.documents.get(id).doc.getText(TEXT_KEY).toString()

async function multiple (options = {}) {
  const ctx = await startHost(options)
  const folder = path.join(ctx.dir, 'Notes')
  await fs.mkdir(path.join(folder, 'Ideas'), { recursive: true })
  const first = path.join(folder, 'readme.md')
  const second = path.join(folder, 'Ideas', 'readme.md')
  await fs.writeFile(first, '# First\n')
  await fs.writeFile(second, '\ufeff# Second\r\n')
  await fs.chmod(second, 0o640)
  await ctx.host.sharePaths([folder])
  return { ...ctx, folder, first, second }
}

test('multi-file: separate CRDTs, same-file convergence, original-path saves and metadata', async () => {
  const ctx = await multiple()
  const session = ctx.host.session
  const firstId = session.files.find(f => f.name === 'Notes/readme.md').id
  const secondId = session.files.find(f => f.name === 'Notes/Ideas/readme.md').id
  const a = client(ctx, { fileId: firstId })
  const b = client(ctx, { fileId: firstId })
  const c = client(ctx, { fileId: secondId })
  try {
    await Promise.all([a, b, c].map(synced))
    assert.equal(a.text.toString(), '# First\n')
    assert.equal(c.text.toString(), '# Second\n')
    a.provider.awareness.setLocalStateField('user', { name: 'On first' })
    a.text.insert(a.text.length, 'A\n')
    b.text.insert(b.text.length, 'B\n')
    c.text.insert(c.text.length, 'C\n')
    await waitFor(() => a.text.toString() === b.text.toString() && textOf(session, firstId).includes('B') && textOf(session, secondId).includes('C'))
    assert.ok(!c.text.toString().includes('A\n'))
    assert.ok(!a.text.toString().includes('C\n'))
    assert.ok(!c.provider.awareness.getStates().has(a.doc.clientID), 'presence cannot cross files')
    await Promise.all(ctx.host.entries.map(e => e.store.flush()))
    assert.equal(await fs.readFile(ctx.first, 'utf8'), a.text.toString())
    assert.equal(await fs.readFile(ctx.second, 'utf8'), '\ufeff' + c.text.toString().replaceAll('\n', '\r\n'))
    assert.equal((await fs.stat(ctx.second)).mode & 0o777, 0o640)
    // An immediate stop flushes pending writes on every original path.
    a.text.insert(0, 'last A\n')
    c.text.insert(0, 'last C\n')
    await waitFor(() => textOf(session, firstId).startsWith('last A') && textOf(session, secondId).startsWith('last C'))
    await ctx.host.stopSharing()
    await waitFor(() => [a, b, c].every(c => c.closes.includes(4000)))
    assert.match(await fs.readFile(ctx.first, 'utf8'), /^last A/)
    assert.match(await fs.readFile(ctx.second, 'utf8'), /^\ufefflast C/)
    assert.equal((await rawUpgrade(ctx.port, { path: `/ws?t=${session.editToken}&e=${session.epoch}&f=${secondId}`, origin: ctx.origin })).status, 401)
  } finally {
    for (const peer of [a, b, c]) peer.close()
    await ctx.host.close()
  }
})

test('folder selection: nested Markdown, dedup, hidden and symlink exclusion; fixed snapshot', async () => {
  const ctx = await multiple()
  try {
    await fs.writeFile(path.join(ctx.folder, 'ignore.txt'), 'not shared')
    await fs.writeFile(path.join(ctx.folder, '.secret.md'), 'not shared')
    await fs.mkdir(path.join(ctx.folder, 'node_modules'))
    await fs.writeFile(path.join(ctx.folder, 'node_modules', 'hidden.md'), 'not shared')
    await fs.symlink(ctx.file, path.join(ctx.folder, 'outside.md'))
    await fs.symlink(ctx.folder, path.join(ctx.folder, 'cycle'))
    const files = await collectShareFiles([ctx.folder, ctx.first, ctx.folder])
    assert.equal(files.length, 2)
    assert.deepEqual(files.map(f => f.name).sort(), ['Notes/Ideas/readme.md', 'Notes/readme.md'])
    await fs.writeFile(path.join(ctx.folder, 'new.MD'), '# New')
    assert.equal(ctx.host.session.files.length, 2, 'adding files does not silently expand access')
    assert.equal((await collectShareFiles([ctx.folder])).length, 3)
    const selected = await collectShareFiles([ctx.first, ctx.second])
    assert.deepEqual(selected.map(f => f.name), ['readme.md', 'readme.md (2)'])
  } finally { await ctx.host.close() }
})

test('invalid selection leaves the active session usable; selection limits are bounded', async () => {
  const ctx = await startHost()
  try {
    const old = ctx.host.session
    const bad = path.join(ctx.dir, 'bad.md')
    await fs.writeFile(bad, Buffer.from([0xff, 0xfe]))
    await assert.rejects(ctx.host.sharePaths([ctx.file, bad]), { code: 'NOT_UTF8' })
    assert.equal(ctx.host.session, old)
    assert.equal(old.stopped, false)
    const empty = path.join(ctx.dir, 'empty')
    await fs.mkdir(empty)
    await assert.rejects(ctx.host.sharePaths([empty]), { code: 'EMPTY_FOLDER' })
    await assert.rejects(collectShareFiles(['relative.md']), { code: 'INVALID_SELECTION' })
    await fs.writeFile(path.join(ctx.dir, 'no.txt'), 'text')
    await assert.rejects(collectShareFiles([path.join(ctx.dir, 'no.txt')]), { code: 'NOT_MARKDOWN' })
    await Promise.all(Array.from({ length: 101 }, (_, n) => fs.writeFile(path.join(empty, `${n}.md`), 'a')))
    await assert.rejects(collectShareFiles([empty]), { code: 'SHARE_LIMIT' })
    assert.equal(ctx.host.session, old)
  } finally { await ctx.host.close() }
})

test('conflict on a non-first file freezes every file and rejects subsequent edits', async () => {
  const ctx = await multiple({ debounceMs: 300 })
  const session = ctx.host.session
  const firstId = session.files.find(f => f.name === 'Notes/readme.md').id
  const secondId = session.files.find(f => f.name === 'Notes/Ideas/readme.md').id
  const a = client(ctx, { fileId: firstId })
  const b = client(ctx, { fileId: secondId })
  let late
  try {
    await Promise.all([synced(a), synced(b)])
    await fs.writeFile(ctx.second, 'external')
    await waitFor(() => a.frozen && b.frozen)
    a.text.insert(0, 'REJECTED')
    b.text.insert(0, 'REJECTED')
    late = client(ctx, { fileId: firstId })
    await synced(late)
    await waitFor(() => late.frozen)
    assert.equal(textOf(session, firstId), '# First\n')
    assert.equal(textOf(session, secondId), '# Second\n')
    await ctx.host.stopSharing()
    assert.equal(await fs.readFile(ctx.second, 'utf8'), 'external')
  } finally { a.close(); b.close(); late?.close(); await ctx.host.close() }
})

test('file IDs are authorized within the session; HTML escapes labels and reveals no original paths', async () => {
  const ctx = await multiple({ guestDir: path.resolve('dist/guest') })
  try {
    const file = path.join(ctx.folder, '<img onerror=bad>.md')
    await fs.writeFile(file, '# Escape')
    await ctx.host.sharePaths([ctx.folder])
    const s = ctx.host.session
    const result = await get(ctx.port, '/')
    assert.equal(result.status, 200)
    assert.ok(result.body.includes('&lt;img onerror=bad&gt;.md'))
    assert.ok(!result.body.includes(ctx.dir))
    assert.ok(!result.body.includes(s.editToken))
    for (const f of s.files) assert.ok(result.body.includes(`data-file="${f.id}"`))
    for (const f of ['../../etc/passwd', 'unknown']) {
      const res = await rawUpgrade(ctx.port, { path: `/ws?t=${s.editToken}&e=${s.epoch}&f=${encodeURIComponent(f)}`, origin: ctx.origin })
      assert.equal(res.status, 404)
    }
    const res = await rawUpgrade(ctx.port, { path: `/ws?t=bad&e=${s.epoch}&f=${s.files[1].id}`, origin: ctx.origin })
    assert.equal(res.status, 401)
    const manifest = JSON.parse(await fs.readFile('dist/guest/manifest.json', 'utf8'))
    const logo = await get(ctx.port, `/assets/${manifest.logo}`)
    assert.equal(logo.status, 200)
    assert.equal(logo.headers['content-type'], 'image/png')
  } finally { await ctx.host.close() }
})

test('stale file ID with an old epoch gets terminal 4001 instead of retrying an unknown file', async () => {
  const ctx = await startHost()
  const fileId = ctx.host.session.files[0].id
  const c = client(ctx, { fileId })
  try {
    await synced(c)
    c.provider.disconnect()
    ctx.host.session.reload('fresh\n')
    c.provider.connect()
    await waitFor(() => c.closes.includes(4001))
    assert.equal(ctx.host.session.text, 'fresh\n')
    assert.equal(ctx.host.session.files[0].name, 'doc.md')
  } finally { c.close(); await ctx.host.close() }
})

test('replacing a share with overlapping files seeds their flushed latest content', async () => {
  const ctx = await startHost({ content: 'before', debounceMs: 5000 })
  const c = client(ctx)
  try {
    await synced(c)
    c.text.insert(0, 'latest ')
    await waitFor(() => ctx.host.session.text === 'latest before')
    const extra = path.join(ctx.dir, 'extra.md')
    await fs.writeFile(extra, 'extra')
    await ctx.host.sharePaths([ctx.file, extra])
    assert.equal(ctx.host.session.text, 'latest before')
    assert.equal(await fs.readFile(ctx.file, 'utf8'), 'latest before')
  } finally { c.close(); await ctx.host.close() }
})
