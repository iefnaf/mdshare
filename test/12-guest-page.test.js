// M1 smoke (no browser): the built guest page is served with a working CSP, its hashed
// assets resolve, the token never appears server-side, and freeze reaches clients.
// Needs `npm run build:guest` (npm test runs it via pretest).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost, get, client, synced, waitFor } from './helpers.js'

const guestDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/guest')
const built = fs.existsSync(path.join(guestDir, 'manifest.json'))
const opts = { skip: !built && 'dist/guest not built: run `npm run build:guest`' }

let ctx
let manifest
before(async () => {
  if (!built) return
  manifest = JSON.parse(fs.readFileSync(path.join(guestDir, 'manifest.json'), 'utf8'))
  ctx = await startHost({ name: 'Notes <b>&.md', guestDir })
})
after(() => ctx?.host.close())

test('GET / serves the editor shell with matching CSP nonce', opts, async () => {
  const res = await get(ctx.port, '/')
  assert.equal(res.status, 200)
  assert.match(res.body, /<main id="editor"/)
  assert.ok(res.body.includes(`<script src="/assets/${manifest.js}">`))
  assert.ok(res.body.includes(`href="/assets/${manifest.css}"`))
  assert.ok(res.body.includes(`content="${ctx.host.session.epoch}"`), 'epoch embedded')
  assert.ok(!res.body.includes(ctx.host.session.editToken), 'token never in page')
  assert.ok(res.body.includes('Notes &lt;b&gt;&amp;.md'), 'title escaped')
  assert.ok(!res.body.includes('<b>'), 'no raw HTML from the filename')

  const nonce = res.body.match(/name="mdshare-nonce" content="([^"]+)"/)?.[1]
  assert.ok(nonce)
  const csp = res.headers['content-security-policy']
  assert.ok(csp.includes(`style-src 'self' 'nonce-${nonce}'`))
  assert.ok(csp.includes(`connect-src ws://${ctx.hostHeader}`))
  assert.ok(csp.includes("script-src 'self'"))
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'))

  const again = await get(ctx.port, '/')
  assert.notEqual(again.body.match(/name="mdshare-nonce" content="([^"]+)"/)?.[1], nonce, 'nonce per request')
})

test('page has Source | Preview toggle and a hidden preview pane', opts, async () => {
  const { body } = await get(ctx.port, '/')
  assert.match(body, /<div id="view-toggle"[^>]*role="group"/)
  assert.match(body, /<button id="view-source"[^>]*data-view="source"[^>]*aria-pressed="true"/)
  assert.match(body, /<button id="view-preview"[^>]*data-view="preview"[^>]*aria-pressed="false"/)
  assert.match(body, /<article id="preview" class="preview" hidden/)
  assert.ok(body.indexOf('id="editor"') < body.indexOf('id="preview"'), 'editor stays the default pane')
})

test('bundle: preview is sanitized, view choice is per-tab only', opts, async () => {
  const { body: js } = await get(ctx.port, `/assets/${manifest.js}`)
  // DOMPurify's public API names survive minification; marked passes raw HTML through,
  // so a bundle without the sanitizer would be an XSS hole.
  assert.ok(js.includes('addHook') && js.includes('sanitize'), 'DOMPurify is bundled')
  assert.ok(js.includes('mdshare-view'), 'view mode key present')
  assert.ok(js.includes('sessionStorage'))
  assert.ok(!/indexedDB\.open/.test(js), 'still no IndexedDB')
})

test('hashed assets resolve with correct types; unknown names 404', opts, async () => {
  const js = await get(ctx.port, `/assets/${manifest.js}`)
  assert.equal(js.status, 200)
  assert.match(js.headers['content-type'], /^text\/javascript/)
  assert.match(js.headers['cache-control'], /immutable/)
  assert.ok(js.body.length > 50_000, 'bundle contains the editor')
  assert.ok(!/indexedDB\.open/.test(js.body), 'no IndexedDB persistence in the bundle')
  const css = await get(ctx.port, `/assets/${manifest.css}`)
  assert.equal(css.status, 200)
  assert.match(css.headers['content-type'], /^text\/css/)
  assert.equal((await get(ctx.port, '/assets/manifest.json')).status, 404)
  assert.equal((await get(ctx.port, '/assets/guest-000000000000.js')).status, 404)
})

test('no session -> friendly 404 page', opts, async () => {
  const c = await startHost({ guestDir })
  try {
    await c.host.stopSharing()
    const res = await get(c.port, '/')
    assert.equal(res.status, 404)
    assert.match(res.body, /not being shared/)
  } finally {
    await c.host.close()
  }
})

test('freeze is pushed to connected clients and to clients that join later', opts, async () => {
  const a = client(ctx)
  let b
  try {
    await synced(a)
    ctx.host.session.freeze({ source: 'test' })
    await waitFor(() => a.frozen, { label: 'connected client frozen' })
    b = client(ctx)
    await synced(b)
    await waitFor(() => b.frozen, { label: 'late client frozen' })
  } finally {
    a.close()
    b?.close()
  }
})
