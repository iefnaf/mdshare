// M0 test 9: LF / CRLF / BOM files stay byte-identical after a no-op edit; non-UTF-8 is rejected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpDir } from './helpers.js'
import { FileStore, MAX_FILE_BYTES } from '../src/core/FileStore.js'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const fixtures = {
  lf: Buffer.from('# T\n\na\nb\n'),
  crlf: Buffer.from('# T\r\n\r\na\r\nb\r\n'),
  'bom-lf': Buffer.concat([BOM, Buffer.from('# T\n\nä\n')]),
  'bom-crlf': Buffer.concat([BOM, Buffer.from('# T\r\n\r\nä\r\n')]),
  'no-trailing-newline': Buffer.from('a\nb'),
  empty: Buffer.alloc(0)
}

async function open (bytes, name = 'doc.md') {
  const dir = await tmpDir()
  const file = path.join(dir, name)
  await fs.writeFile(file, bytes)
  return { file, store: await FileStore.open(file, { backupRoot: path.join(dir, 'b') }) }
}

for (const [name, bytes] of Object.entries(fixtures)) {
  test(`round-trip ${name}: edit then undo is byte-identical`, async () => {
    const { file, store } = await open(bytes)
    assert.ok(!store.text.includes('\r'), 'editor text is \\n-normalized')
    assert.ok(await store.save(store.text + 'x\n'))
    assert.ok(await store.save(store.text))
    assert.deepEqual(await fs.readFile(file), bytes)
  })
}

test('mixed line endings: warned, dominant style used', async () => {
  const { store } = await open(Buffer.from('a\r\nb\r\nc\n'))
  assert.deepEqual(store.warnings, ['MIXED_LINE_ENDINGS'])
  assert.equal(store.format.eol, '\r\n')
})

for (const [name, bytes, code] of [
  ['Latin-1', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), 'NOT_UTF8'],
  ['UTF-16LE', Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), 'NOT_UTF8'],
  ['NUL byte', Buffer.from('a\0b'), 'BINARY'],
  ['> 2 MB', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61), 'TOO_LARGE']
]) {
  test(`rejects ${name}`, async () => {
    const dir = await tmpDir()
    const file = path.join(dir, 'doc.md')
    await fs.writeFile(file, bytes)
    await assert.rejects(FileStore.open(file, { backupRoot: dir }), { code })
    assert.deepEqual(await fs.readFile(file), bytes, 'untouched')
  })
}

test('symlink: resolves to the real file and writes through it', async () => {
  const dir = await tmpDir()
  const real = path.join(dir, 'real.md')
  const link = path.join(dir, 'link.md')
  await fs.writeFile(real, 'a\n')
  await fs.symlink(real, link)
  const store = await FileStore.open(link, { backupRoot: path.join(dir, 'b') })
  await store.save('b\n')
  assert.equal(await fs.readFile(real, 'utf8'), 'b\n')
  assert.ok((await fs.lstat(link)).isSymbolicLink(), 'link preserved')
})

test('first write makes one backup of the original bytes', async () => {
  const { store } = await open(fixtures.crlf)
  await store.save('changed\n')
  await store.save('changed again\n')
  const files = await fs.readdir(store.backupDir)
  assert.equal(files.length, 1)
  assert.deepEqual(await fs.readFile(path.join(store.backupDir, files[0])), fixtures.crlf)
})
