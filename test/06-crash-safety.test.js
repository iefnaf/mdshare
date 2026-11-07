// M0 test 6: kill -9 a writer 200 times at random points; the file is always a
// complete known version and valid UTF-8; stale temp files are cleaned up on reopen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir, rng } from './helpers.js'
import { versions } from './fixtures/versions.js'
import { FileStore } from '../src/core/FileStore.js'

const WRITER = fileURLToPath(new URL('./fixtures/writer.js', import.meta.url))
const KILLS = Number(process.env.MDSHARE_KILLS ?? 200)

function runAndKill (file, backupRoot, delayMs) {
  return new Promise((resolve, reject) => {
    // process.execPath is the Electron binary under npm test; ELECTRON_RUN_AS_NODE is inherited.
    const child = spawn(process.execPath, [WRITER, file, backupRoot], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += d })
    child.stdout.on('data', d => {
      if (d.toString().includes('READY')) setTimeout(() => child.kill('SIGKILL'), delayMs)
    })
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL') resolve()
      else reject(new Error(`writer exited ${code}: ${err}`))
    })
  })
}

test(`crash safety: ${KILLS} SIGKILLs mid-save never leave a torn file`, { timeout: 600_000 }, async () => {
  const seed = Number(process.env.MDSHARE_SEED ?? Date.now() % 1e9)
  const rand = rng(seed)
  const dir = await tmpDir()
  const file = path.join(dir, 'doc.md')
  const backupRoot = path.join(dir, 'backups')
  await fs.writeFile(file, versions[0])
  const seen = new Set()

  for (let i = 0; i < KILLS; i++) {
    await runAndKill(file, backupRoot, Math.floor(rand() * 40))
    const bytes = await fs.readFile(file)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) // throws on invalid UTF-8
    const idx = versions.indexOf(text)
    assert.ok(idx !== -1, `kill ${i}: file is not a complete known version (len ${bytes.length}, seed ${seed})`)
    seen.add(idx)
  }
  // Sanity: the writer actually made progress across kills (otherwise the test proves nothing).
  assert.ok(seen.size > 1, `writer never completed a save (seed ${seed})`)

  // Reopen cleans up our leftover temp files and only those.
  await fs.writeFile(path.join(dir, 'unrelated.tmp'), 'keep me')
  await FileStore.open(file, { backupRoot })
  const left = await fs.readdir(dir)
  assert.deepEqual(left.filter(n => n.includes('.mdshare-')), [])
  assert.ok(left.includes('unrelated.tmp'))
})
