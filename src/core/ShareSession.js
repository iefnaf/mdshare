// One share of one file. Owns the authoritative Y.Doc for the current epoch.
//
// Lifecycle (PLAN: Decisions):
//   ShareSession.start(text)  -> new epoch + new editToken, server seeds the doc (G1)
//   session.reload(text)      -> new epoch, same token ("Load disk version"); old clients get 4001
//   session.stop()            -> token revoked; all sockets closed with 4000
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

export const TEXT_KEY = 'md'

const newId = () => randomBytes(16).toString('base64url') // 128-bit

export class ShareSession extends EventEmitter {
  /** @param {string} text  initial content (already normalized to \n) */
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
    this.doc = new Y.Doc()
    // Server-side seeding only: clients never insert initial content (G1).
    if (text) this.doc.getText(TEXT_KEY).insert(0, text)
    this.awareness = new Awareness(this.doc)
    this.awareness.setLocalState(null) // the server itself has no presence
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
    this.awareness.destroy()
    this.doc.destroy()
  }
}
