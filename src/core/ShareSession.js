// One share, one token and epoch, with an independent Y.Doc per file.
//
// Lifecycle (PLAN: Decisions):
//   ShareSession.start(text)  -> new epoch + new editToken, server seeds the doc (G1)
//   session.reload(text)      -> new epoch, same token ("Load disk version"); old clients get 4001
//   session.stop()            -> token revoked; all sockets closed with 4000
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { TEXT_KEY } from './protocol.js'

export { TEXT_KEY }

const newId = () => randomBytes(16).toString('base64url') // 128-bit

export class ShareSession extends EventEmitter {
  /** @param {string | Array<{name:string,text:string}>} text initial normalized content */
  static start (text) {
    return new ShareSession(text, newId())
  }

  constructor (text, editToken) {
    super()
    this.editToken = editToken
    this.stopped = false
    this.#newEpoch(text)
  }

  #newEpoch (text) {
    this.epoch = newId()
    this.frozen = false
    const files = Array.isArray(text) ? text : [{ name: this.files?.[0]?.name ?? 'Shared document', text }]
    if (!files.length) throw new Error('A share needs at least one file')
    this.documents = new Map(files.map(file => {
      const id = newId()
      const doc = new Y.Doc()
      // Only the server seeds content; each file has its own CRDT and presence.
      if (file.text) doc.getText(TEXT_KEY).insert(0, file.text)
      const awareness = new Awareness(doc)
      awareness.setLocalState(null)
      return [id, { id, name: file.name, doc, awareness }]
    }))
    this.files = [...this.documents.values()].map(({ id, name }) => ({ id, name }))
    const first = this.documents.values().next().value
    this.doc = first.doc
    this.awareness = first.awareness
  }

  get text () {
    return this.doc.getText(TEXT_KEY).toString()
  }

  /** Constant-time token check. Returns false once stopped. */
  checkToken (candidate) {
    if (this.stopped || typeof candidate !== 'string') return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(this.editToken)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  checkEpoch (candidate) {
    return !this.stopped && candidate === this.epoch
  }

  freeze (reason) {
    if (this.frozen) return
    this.frozen = true
    this.emit('frozen', reason)
  }

  /** Start a fresh epoch from new disk text, keeping the link valid. */
  reload (text) {
    if (this.files.length > 1) throw new Error('Restart sharing to reload a multi-file session')
    const old = { doc: this.doc, awareness: this.awareness, epoch: this.epoch }
    this.#newEpoch(text)
    this.emit('epoch', old)
    old.awareness.destroy()
    old.doc.destroy()
  }

  stop () {
    if (this.stopped) return
    this.stopped = true
    this.emit('stopped')
    for (const { doc, awareness } of this.documents.values()) {
      awareness.destroy()
      doc.destroy()
    }
  }
}
