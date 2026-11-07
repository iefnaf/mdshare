// Composition: one session and server, independent stores and CRDTs per file.
import os from 'node:os'
import fs from 'node:fs/promises'
import { ShareSession } from './ShareSession.js'
import { SyncServer } from './SyncServer.js'
import { FileStore, decodeMarkdown } from './FileStore.js'
import { TEXT_KEY } from './protocol.js'
import { Watcher } from './Watcher.js'
import { loadGuestAssets } from './guestAssets.js'
import { collectShareFiles, MAX_SHARE_BYTES } from './shareFiles.js'

/** "ip:port" for each non-internal IPv4 interface, plus "<LocalHostName>.local:port" (G4). */
export function lanHosts (port, localHostName = os.hostname()) {
  const hosts = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) hosts.push(`${a.address}:${port}`)
    }
  }
  const name = localHostName.toLowerCase().replace(/\.local$/, '')
  if (name) hosts.push(`${name}.local:${port}`)
  return hosts
}

export class Host {
  /**
   * @param {object} opts
   * @param {string} opts.backupRoot
   * @param {(port:number)=>string[]} [opts.allowedHosts]
   * @param {number} [opts.debounceMs]
   * @param {string} [opts.guestDir]  built guest bundle (dist/guest); omitted in headless tests
   */
  constructor ({ backupRoot, allowedHosts = port => lanHosts(port), debounceMs, guestDir }) {
    this.backupRoot = backupRoot
    this.debounceMs = debounceMs
    this.port = 0
    const guest = guestDir ? loadGuestAssets(guestDir) : {}
    this.server = new SyncServer({
      allowedHosts: () => allowedHosts(this.port),
      assets: guest.assets,
      renderIndex: guest.renderIndex
    })
    this.session = null
    this.store = null
    this.watcher = null
    this.entries = []
  }

  async listen (port = 0, bindHost = '0.0.0.0') {
    const addr = await this.server.listen(port, bindHost)
    this.port = addr.port
    return addr
  }

  async shareFile (filePath) {
    return this.sharePaths([filePath])
  }

  async sharePaths (paths) {
    // Validate the entire selection before ending a working share. Opening stores
    // happens after the old share flushes, so overlapping files seed fresh bytes.
    const selection = await collectShareFiles(paths)
    for (const file of selection) {
      decodeMarkdown(await fs.readFile(file.path))
    }
    await this.stopSharing()
    const entries = []
    let session
    try {
      let total = 0
      for (const file of selection) {
        const store = await FileStore.open(file.path, { backupRoot: this.backupRoot, debounceMs: this.debounceMs })
        total += store.lastKnown.size
        if (total > MAX_SHARE_BYTES) throw new Error('Selection grew beyond 20 MB. Choose fewer files.')
        entries.push({ ...file, store, watcher: new Watcher(store) })
      }
      session = ShareSession.start(entries.map(e => ({ name: e.name, text: e.store.text })))
      session.title = entries.length === 1 ? entries[0].name : `${entries.length} shared files`
      const attachDocs = () => entries.forEach((entry, i) => {
        const resource = session.documents.get(session.files[i].id)
        const text = resource.doc.getText(TEXT_KEY)
        text.observe(() => { if (!session.frozen) entry.store.scheduleSave(text.toString()) })
      })
      attachDocs()
      session.on('epoch', attachDocs)
      entries.forEach(entry => {
        const freeze = e => session.freeze({ file: entry.name, ...e })
        entry.store.on('conflict', e => freeze({ source: 'save', ...e }))
        entry.store.on('error', e => freeze({ source: 'save', reason: e.message }))
        entry.watcher.on('external-change', e => freeze({ source: 'watch', ...e }))
        entry.watcher.on('error', e => freeze({ source: 'watch', reason: e.message }))
        entry.watcher.start()
      })
      this.server.setSession(session)
      Object.assign(this, { session, entries, store: entries[0].store, watcher: entries[0].watcher })
      return session
    } catch (error) {
      for (const entry of entries) entry.watcher.stop()
      session?.stop()
      throw error
    }
  }

  async stopSharing () {
    if (!this.session) return
    for (const entry of this.entries) entry.watcher.stop()
    // Close editing before awaiting disk IO, otherwise edits can arrive after flush.
    this.session.stop()
    this.server.setSession(null)
    await Promise.all(this.entries.map(entry => entry.store.flush()))
    this.entries = []
    this.session = this.store = this.watcher = null
  }

  async close () {
    await this.stopSharing()
    await this.server.close()
  }
}
