// Watches the file's parent directory (atomic-rename saves replace the inode, so
// watching the file itself would go deaf after the first external save).
// Emits 'external-change' when the bytes at our path are not something we wrote.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { sha256 } from './FileStore.js'

export class Watcher extends EventEmitter {
  /** @param {import('./FileStore.js').FileStore} store */
  constructor (store, { debounceMs = 150 } = {}) {
    super()
    this.store = store
    this.debounceMs = debounceMs
    this._timer = null
    this._fsw = null
  }

  start () {
    const dir = path.dirname(this.store.path)
    this._fsw = fs.watch(dir, { persistent: false }, (_event, name) => {
      // name can be null on some platforms; then always re-check.
      if (name && name.toString() !== this.store.basename) return
      clearTimeout(this._timer)
      this._timer = setTimeout(() => this.check(), this.debounceMs)
    })
    this._fsw.on('error', err => this.emit('error', err))
    return this
  }

  /** Re-resolve the path and compare content against what we know we wrote. */
  async check () {
    let bytes
    try {
      bytes = await fsp.readFile(this.store.path)
    } catch (err) {
      if (err.code === 'ENOENT') return this.emit('external-change', { reason: 'missing' })
      return this.emit('error', err)
    }
    const hash = sha256(bytes)
    if (hash === this.store.lastKnown.hash || this.store.ownHashes.has(hash)) return
    this.emit('external-change', { reason: 'changed', hash })
  }

  stop () {
    clearTimeout(this._timer)
    this._fsw?.close()
    this._fsw = null
  }
}
