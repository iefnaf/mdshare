import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Host } from '../src/core/Host.js'
import { TEXT_KEY } from '../src/core/ShareSession.js'
import { CLOSE } from '../src/core/SyncServer.js'

const TERMINAL_CODES = new Set([CLOSE.STOPPED, CLOSE.STALE_EPOCH, CLOSE.TOO_LARGE_DOC])

export async function tmpDir () {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mdshare-test-'))
}

/** A Host bound to loopback whose only allowed Host header is 127.0.0.1:<port>. */
export async function startHost ({ content = '# Hello\n\nworld\n', name = 'doc.md', debounceMs = 50 } = {}) {
  const dir = await tmpDir()
  const file = path.join(dir, name)
  await fs.writeFile(file, content)
  const host = new Host({
    backupRoot: path.join(dir, 'backups'),
    allowedHosts: port => [`127.0.0.1:${port}`],
    debounceMs
  })
  const { port } = await host.listen(0, '127.0.0.1')
  const session = await host.shareFile(file)
  return { host, session, port, dir, file, hostHeader: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }
}

/** ws subclass that sends a browser-like Origin header. */
export function wsWithOrigin (origin) {
  return class OriginWebSocket extends WebSocket {
    constructor (url, protocols) {
      super(url, protocols ?? [], { origin })
    }
  }
}

/** A real y-websocket client (same library the guest browser will use). */
export function client (ctx, { epoch = ctx.host.session.epoch, token = ctx.host.session.editToken, connect = true } = {}) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://${ctx.hostHeader}`, 'ws', doc, {
    WebSocketPolyfill: wsWithOrigin(ctx.origin),
    params: { e: epoch, t: token },
    connect,
    disableBc: true, // BroadcastChannel would sync docs in-process and bypass the server
    resyncInterval: -1,
    maxBackoffTime: 200,
    // Same policy the guest page will use: 4000 (stopped) / 4001 (stale epoch) are terminal.
    shouldReconnect: ev => !TERMINAL_CODES.has(ev?.code)
  })
  const closes = []
  provider.on('connection-close', ev => closes.push(ev?.code))
  const c = {
    doc,
    provider,
    text: doc.getText(TEXT_KEY),
    closes,
    // provider.destroy() clears its own timers but NOT the Awareness it created,
    // whose 3s outdated-check setInterval keeps the event loop (and node:test) alive.
    closed: false,
    close () {
      if (c.closed) return
      c.closed = true
      provider.destroy()
      provider.awareness.destroy()
      doc.destroy()
    }
  }
  return c
}

export function waitFor (pred, { timeout = 5000, interval = 10, label = 'condition' } = {}) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false
      try { ok = pred() } catch {}
      if (ok) return resolve()
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, interval)
    }
    tick()
  })
}

export const synced = c => waitFor(() => c.provider.synced, { label: 'provider synced' })

/**
 * Raw WebSocket upgrade request, so tests control Host/Origin exactly.
 * Resolves {status} for a rejected handshake or {upgraded:true, socket} for an accepted one.
 */
export function rawUpgrade (port, { path: p = '/ws', host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64')
    }
    if (host !== undefined) headers.Host = host
    if (origin !== undefined) headers.Origin = origin
    const req = http.request({ host: '127.0.0.1', port, path: p, headers, setHost: host === undefined })
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode, upgraded: false }) })
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, upgraded: true, socket }))
    req.on('error', reject)
    req.end()
  })
}

export function get (port, p, { host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = host ? { Host: host } : {}
    const req = http.request({ host: '127.0.0.1', port, path: p, headers, setHost: !host }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Deterministic PRNG so failures are reproducible (seed printed by tests). */
export function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
