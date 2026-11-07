// The original file on disk: validation, encoding round-trip, backups and
// compare-and-swap atomic saves (PLAN: Data safety, G2).
//
// Not yet: copying xattrs/Finder tags/ACLs (G3 native addon). Mode bits are preserved.
import fs from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const BACKUPS_KEPT = 20
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

export class FileError extends Error {
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

export const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/** Decode and normalize file bytes. Throws FileError for anything we refuse in the MVP. */
export function decodeMarkdown (bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new FileError('TOO_LARGE', `file is larger than ${MAX_FILE_BYTES} bytes`)
  const bom = bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM)
  const body = bom ? bytes.subarray(3) : bytes
  let raw
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    throw new FileError('NOT_UTF8', 'file is not valid UTF-8')
  }
  if (raw.includes('\0')) throw new FileError('BINARY', 'file contains NUL bytes')

  const crlf = (raw.match(/\r\n/g) ?? []).length
  const lf = (raw.match(/\n/g) ?? []).length - crlf
  const cr = (raw.match(/\r(?!\n)/g) ?? []).length
  const eol = crlf > lf ? '\r\n' : '\n'
  const warnings = []
  if ((crlf && lf) || cr) warnings.push('MIXED_LINE_ENDINGS')
  return { text: raw.replace(/\r\n?/g, '\n'), bom, eol, warnings }
}

export function encodeMarkdown (text, { bom, eol }) {
  const body = Buffer.from(eol === '\n' ? text : text.replace(/\n/g, eol), 'utf8')
  return bom ? Buffer.concat([BOM, body]) : body
}

export class FileStore extends EventEmitter {
  /**
   * @param {string} filePath  as dropped by the user (symlinks are resolved)
   * @param {{backupRoot: string, debounceMs?: number}} opts
   */
  static async open (filePath, opts) {
    const real = await fs.realpath(filePath)
    const st = await fs.stat(real)
    if (!st.isFile()) throw new FileError('NOT_FILE', 'not a regular file')
    const bytes = await fs.readFile(real)
    const decoded = decodeMarkdown(bytes)
    await removeStaleTemps(real)
    return new FileStore(real, bytes, st, decoded, opts)
  }

  constructor (realPath, bytes, st, decoded, { backupRoot, debounceMs = 500 }) {
    super()
    this.path = realPath
    this.basename = path.basename(realPath)
    this.text = decoded.text
    this.format = { bom: decoded.bom, eol: decoded.eol }
    this.warnings = decoded.warnings
    this.mode = st.mode & 0o7777
    this.lastKnown = { hash: sha256(bytes), size: st.size, mtimeMs: st.mtimeMs }
    /** hashes of content we wrote ourselves; the Watcher ignores these */
    this.ownHashes = new Set([this.lastKnown.hash])
    this.backupDir = path.join(backupRoot, sha256(Buffer.from(realPath)).slice(0, 16))
    this.debounceMs = debounceMs
    this.backedUp = false
    this.conflict = false
    this._timer = null
    this._pendingText = null
    this._chain = Promise.resolve()
  }

  /** Debounced autosave of the latest text. */
  scheduleSave (text) {
    this._pendingText = text
    clearTimeout(this._timer)
    this._timer = setTimeout(() => { this._timer = null; this.#enqueue() }, this.debounceMs)
  }

  /** Write any pending text now and wait for all queued writes. */
  async flush () {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
      this.#enqueue()
    }
    await this._chain
  }

  #enqueue () {
    const text = this._pendingText
    this._pendingText = null
    if (text == null) return
    this._chain = this._chain.then(() => this.save(text)).catch(err => this.emit('error', err))
  }

  /**
   * Compare-and-swap atomic save. Returns true if written, false if the disk
   * changed underneath us (in which case nothing is written and 'conflict' is emitted).
   */
  async save (text) {
    if (this.conflict) return false
    const bytes = encodeMarkdown(text, this.format)
    if (bytes.length > MAX_FILE_BYTES) throw new FileError('TOO_LARGE', 'document grew past the size limit')

    let disk
    try {
      disk = await fs.readFile(this.path)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      disk = null
    }
    if (!disk || sha256(disk) !== this.lastKnown.hash) {
      this.conflict = true
      this.emit('conflict', { reason: disk ? 'changed' : 'missing' })
      return false
    }
    const hash = sha256(bytes)
    if (hash === this.lastKnown.hash) return true // nothing to do

    if (!this.backedUp) {
      await this.backup(disk, 'session-start')
      this.backedUp = true
    }

    const dir = path.dirname(this.path)
    const tmp = path.join(dir, `${tempPrefix(this.basename)}${randomBytes(6).toString('hex')}.tmp`)
    this.ownHashes.add(hash)
    const fh = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600)
    try {
      await fh.writeFile(bytes)
      await fh.chmod(this.mode)
      await fh.sync()
    } catch (err) {
      await fh.close()
      await fs.rm(tmp, { force: true })
      throw err
    }
    await fh.close()
    try {
      await fs.rename(tmp, this.path)
    } catch (err) {
      await fs.rm(tmp, { force: true })
      throw err
    }
    await fsyncDir(dir)
    const st = await fs.stat(this.path)
    this.lastKnown = { hash, size: st.size, mtimeMs: st.mtimeMs }
    this.emit('saved', this.lastKnown)
    return true
  }

  /** Copy bytes into the backup folder, keeping the newest BACKUPS_KEPT. */
  async backup (bytes, label) {
    await fs.mkdir(this.backupDir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${stamp}-${label}-${randomBytes(3).toString('hex')}.md`
    const target = path.join(this.backupDir, name)
    await fs.writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
    const all = (await fs.readdir(this.backupDir)).filter(n => n.endsWith('.md')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) {
      await fs.rm(path.join(this.backupDir, old), { force: true })
    }
    return target
  }
}

const tempPrefix = basename => `.${basename}.mdshare-`
const TEMP_SUFFIX = /^[0-9a-f]{12}\.tmp$/

/** A crash between write and rename leaves our temp file behind; only ours match this pattern. */
async function removeStaleTemps (realPath) {
  const dir = path.dirname(realPath)
  const prefix = tempPrefix(path.basename(realPath))
  for (const name of await fs.readdir(dir)) {
    if (name.startsWith(prefix) && TEMP_SUFFIX.test(name.slice(prefix.length))) {
      await fs.rm(path.join(dir, name), { force: true })
    }
  }
}

async function fsyncDir (dir) {
  const fh = await fs.open(dir, FS.O_RDONLY)
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}
