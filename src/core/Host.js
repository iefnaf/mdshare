// Composition of the headless core: one file, one session, one server.
// The Electron main process (later) only calls shareFile()/stopSharing().
import os from 'node:os'
import { ShareSession } from './ShareSession.js'
import { SyncServer } from './SyncServer.js'
import { FileStore } from './FileStore.js'
import { Watcher } from './Watcher.js'
import { loadGuestAssets } from './guestAssets.js'

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
  }

  async listen (port = 0, bindHost = '0.0.0.0') {
    const addr = await this.server.listen(port, bindHost)
    this.port = addr.port
    return addr
  }

  async shareFile (filePath) {
    await this.stopSharing()
    const store = await FileStore.open(filePath, { backupRoot: this.backupRoot, debounceMs: this.debounceMs })
    const session = ShareSession.start(store.text)
    session.title = store.basename
    const watcher = new Watcher(store).start()

    const attachDoc = () => {
      session.doc.on('update', () => store.scheduleSave(session.text))
    }
    attachDoc()
    session.on('epoch', attachDoc)
    store.on('conflict', e => session.freeze({ source: 'save', ...e }))
    watcher.on('external-change', e => session.freeze({ source: 'watch', ...e }))

    this.server.setSession(session)
    Object.assign(this, { session, store, watcher })
    return session
  }

  async stopSharing () {
    if (!this.session) return
    this.watcher.stop()
    await this.store.flush()
    this.session.stop()
    this.server.setSession(null)
    this.session = this.store = this.watcher = null
  }

  async close () {
    await this.stopSharing()
    await this.server.close()
  }
}
