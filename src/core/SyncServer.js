// HTTP + WebSocket server. Fixed routes only: GET /, GET /assets/<name>, WS /ws.
// Speaks the y-protocols sync + awareness wire format (compatible with y-websocket clients),
// with our own gates for Host, Origin, token, capacity, epoch, size and freeze.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { TEXT_KEY, MSG_SYNC, MSG_AWARENESS, MSG_FROZEN, CLOSE } from './protocol.js'

export { MSG_SYNC, MSG_AWARENESS, MSG_FROZEN, CLOSE }

export const DEFAULT_LIMITS = Object.freeze({
  maxPayload: 256 * 1024, // ws frame limit -> close 1009
  maxDocChars: 2 * 1024 * 1024,
  maxConnections: 8
})

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
}

/**
 * CSP for the guest page. `host` is the already-allowlisted Host header.
 * The nonce exists only because CodeMirror injects <style> elements (EditorView.cspNonce).
 * connect-src names the exact ws origin: Safari doesn't reliably treat 'self' as covering ws:.
 */
export function pageCsp (host, nonce) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    `connect-src ws://${host}`,
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

const ASSET_HEADERS = { ...SECURITY_HEADERS, 'Cache-Control': 'public, max-age=31536000, immutable' }

function rejectUpgrade (socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export class SyncServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => string[]} opts.allowedHosts  current allowlist of "host:port" values (recomputed per request)
   * @param {Map<string,{type:string,body:Buffer|string}>} [opts.assets]  fixed, prebuilt assets
   * @param {(session:any, ctx:{nonce:string})=>string} [opts.renderIndex]  index HTML for the current session
   * @param {Partial<typeof DEFAULT_LIMITS>} [opts.limits]
   */
  constructor ({ allowedHosts, assets = new Map(), renderIndex, limits = {} }) {
    super()
    this.allowedHosts = allowedHosts
    this.assets = assets
    this.renderIndex = renderIndex ?? defaultIndex
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.session = null
    /** @type {Set<Conn>} */
    this.conns = new Set()
    this.http = http.createServer((req, res) => this.#onRequest(req, res))
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxPayload })
    this.http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head))
  }

  listen (port, host) {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, host, () => {
        this.http.off('error', reject)
        resolve(this.http.address())
      })
    })
  }

  async close () {
    this.#closeAll(CLOSE.STOPPED, 'server closing')
    this.#detachSession()
    const closed = new Promise(resolve => this.http.close(() => resolve()))
    // Don't wait for clients to answer the close handshake or for keep-alive sockets to idle out.
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
    this.http.closeAllConnections()
    await closed
  }

  /** Attach a ShareSession (or null to stop serving). */
  setSession (session) {
    this.#detachSession()
    this.session = session
    if (!session) return
    const onEpoch = () => {
      for (const c of [...this.conns]) {
        if (c.epoch !== session.epoch) c.ws.close(CLOSE.STALE_EPOCH, 'stale epoch')
      }
      this.#bindDoc(session)
    }
    const onStopped = () => {
      this.#closeAll(CLOSE.STOPPED, 'sharing stopped')
      this.#detachSession()
    }
    const onFrozen = () => this.#broadcast(session.epoch, frozenMessage(), null)
    session.on('epoch', onEpoch)
    session.on('stopped', onStopped)
    session.on('frozen', onFrozen)
    this.#unbindSession = () => {
      session.off('epoch', onEpoch)
      session.off('stopped', onStopped)
      session.off('frozen', onFrozen)
    }
    this.#bindDoc(session)
  }

  #unbindSession = () => {}
  #unbindDoc = () => {}

  #detachSession () {
    this.#unbindSession()
    this.#unbindSession = () => {}
    this.#unbindDoc()
    this.#unbindDoc = () => {}
    this.session = null
  }

  /** Broadcast doc + awareness updates of the current epoch to its connections. */
  #bindDoc (session) {
    this.#unbindDoc()
    const { doc, awareness, epoch } = session
    const onUpdate = (update, origin) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.#broadcast(epoch, encoding.toUint8Array(enc), origin)
    }
    const onAwareness = ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin instanceof Conn) {
        // remember which client ids a connection controls, to clean up on close
        for (const id of added) origin.awarenessIds.add(id)
        for (const id of removed) origin.awarenessIds.delete(id)
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      this.#broadcast(epoch, encoding.toUint8Array(enc), null)
    }
    doc.on('update', onUpdate)
    awareness.on('update', onAwareness)
    this.#unbindDoc = () => {
      doc.off('update', onUpdate)
      awareness.off('update', onAwareness)
    }
  }

  #broadcast (epoch, msg, except) {
    for (const c of this.conns) {
      if (c.epoch === epoch && c !== except) c.send(msg)
    }
  }

  #closeAll (code, reason) {
    for (const c of [...this.conns]) c.ws.close(code, reason)
  }

  // ---- HTTP -----------------------------------------------------------------

  #hostAllowed (req) {
    const host = req.headers.host
    return typeof host === 'string' && this.allowedHosts().includes(host.toLowerCase())
  }

  #onRequest (req, res) {
    const send = (status, type, body, headers = SECURITY_HEADERS) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (!this.#hostAllowed(req)) return send(421, 'text/plain; charset=utf-8', 'Misdirected Request')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(404, 'text/plain; charset=utf-8', 'Not Found')

    // Match the raw request target exactly; never decode or normalize into a filesystem path.
    const raw = req.url ?? ''
    const q = raw.indexOf('?')
    const path = q === -1 ? raw : raw.slice(0, q)

    if (path === '/') {
      if (!this.session) {
        return send(404, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Not shared</title><p>This document is not being shared right now.</p>')
      }
      const nonce = randomBytes(16).toString('base64')
      const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': pageCsp(req.headers.host.toLowerCase(), nonce) }
      return send(200, 'text/html; charset=utf-8', this.renderIndex(this.session, { nonce }), headers)
    }
    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length)
      if (ASSET_NAME.test(name) && !name.includes('..') && this.assets.has(name)) {
        const a = this.assets.get(name)
        return send(200, a.type, a.body, ASSET_HEADERS)
      }
    }
    return send(404, 'text/plain; charset=utf-8', 'Not Found')
  }

  // ---- WebSocket handshake ----------------------------------------------------

  #onUpgrade (req, socket, head) {
    socket.on('error', () => socket.destroy())
    if (!this.#hostAllowed(req)) return rejectUpgrade(socket, 421, 'Misdirected Request')

    const raw = req.url ?? ''
    const q = raw.indexOf('?')
    if ((q === -1 ? raw : raw.slice(0, q)) !== '/ws') return rejectUpgrade(socket, 404, 'Not Found')
    const url = new URL(raw, 'http://placeholder')

    // Origin must be exactly the origin we serve the page from (anti CSWSH / DNS rebinding).
    const origin = req.headers.origin
    if (origin !== `http://${req.headers.host.toLowerCase()}`) return rejectUpgrade(socket, 403, 'Forbidden')

    const session = this.session
    if (!session || !session.checkToken(url.searchParams.get('t'))) return rejectUpgrade(socket, 401, 'Unauthorized')
    if (this.conns.size >= this.limits.maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable')

    const epoch = url.searchParams.get('e')
    this.wss.handleUpgrade(req, socket, head, ws => {
      // Epoch is checked after upgrade so the browser sees a readable close code.
      if (!session.checkEpoch(epoch)) {
        ws.close(CLOSE.STALE_EPOCH, 'stale epoch')
        return
      }
      this.#onConnection(ws, session)
    })
  }

  // ---- Sync protocol ------------------------------------------------------------

  #onConnection (ws, session) {
    const conn = new Conn(ws, session.epoch)
    this.conns.add(conn)
    const { doc, awareness } = session

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return // protocol is binary only
      if (session.stopped || conn.epoch !== session.epoch) return
      try {
        this.#onMessage(conn, session, new Uint8Array(data))
      } catch (err) {
        this.emit('protocol-error', err)
        ws.close(1002, 'protocol error')
      }
    })
    ws.on('close', () => {
      this.conns.delete(conn)
      if (!session.stopped && conn.epoch === session.epoch && conn.awarenessIds.size) {
        awarenessProtocol.removeAwarenessStates(awareness, [...conn.awarenessIds], null)
      }
      this.emit('disconnect', conn)
    })
    ws.on('error', () => {})

    // Greet: our state vector (client answers with its missing updates) + current awareness.
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, doc)
    conn.send(encoding.toUint8Array(enc))
    const states = [...awareness.getStates().keys()]
    if (states.length) {
      const aenc = encoding.createEncoder()
      encoding.writeVarUint(aenc, MSG_AWARENESS)
      encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(awareness, states))
      conn.send(encoding.toUint8Array(aenc))
    }
    if (session.frozen) conn.send(frozenMessage())
    this.emit('connect', conn)
  }

  #onMessage (conn, session, buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      const sub = decoding.readVarUint(dec)
      if (sub === syncProtocol.messageYjsSyncStep1) {
        const sv = decoding.readVarUint8Array(dec)
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_SYNC)
        encoding.writeVarUint(enc, syncProtocol.messageYjsSyncStep2)
        encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(session.doc, sv))
        conn.send(encoding.toUint8Array(enc))
      } else if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
        const update = decoding.readVarUint8Array(dec)
        if (session.frozen) {
          this.emit('dropped-update', { conn, reason: 'frozen' })
          return
        }
        // Conservative bound: an update can add at most ~its byte length in characters.
        const current = session.doc.getText(TEXT_KEY).length
        if (current + update.byteLength > this.limits.maxDocChars) {
          this.emit('dropped-update', { conn, reason: 'too-large' })
          conn.ws.close(CLOSE.TOO_LARGE_DOC, 'document too large')
          return
        }
        Y.applyUpdate(session.doc, update, conn)
      } else {
        throw new Error(`unknown sync message ${sub}`)
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(session.awareness, decoding.readVarUint8Array(dec), conn)
    } else {
      throw new Error(`unknown message type ${type}`)
    }
  }
}

export class Conn {
  constructor (ws, epoch) {
    this.ws = ws
    this.epoch = epoch
    this.awarenessIds = new Set()
  }

  send (msg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(msg, { binary: true })
  }
}

function frozenMessage () {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_FROZEN)
  encoding.writeVarUint(enc, 1)
  return encoding.toUint8Array(enc)
}

export function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function defaultIndex (session) {
  // Epoch is not secret; token stays in the URL fragment and is never sent to GET /.
  return `<!doctype html><meta charset="utf-8"><meta name="mdshare-epoch" content="${escapeHtml(session.epoch)}"><title>${escapeHtml(session.title ?? 'mdshare')}</title><p>mdshare (M0 headless)</p>`
}
