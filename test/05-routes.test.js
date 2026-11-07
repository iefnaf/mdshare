// M0 test 5: only fixed routes; traversal attempts and project files return 404.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHost, get } from './helpers.js'

let ctx
before(async () => { ctx = await startHost({ name: 'secret-notes.md' }) })
after(() => ctx.host.close())

test('traversal and non-route paths -> 404', async () => {
  const paths = [
    '/../x', '/assets/../main.js', '/package.json', '/%2e%2e/', '/%2e%2e/package.json',
    '/assets/%2e%2e%2fpackage.json', '/assets/', '/assets/..', '/src/core/Host.js',
    '//etc/passwd', '/node_modules/yjs/package.json', '/secret-notes.md', '/index.html', '/ws'
  ]
  for (const p of paths) {
    const res = await get(ctx.port, p)
    assert.equal(res.status, 404, p)
  }
})

test('GET / serves index with security headers and no local path', async () => {
  const res = await get(ctx.port, '/')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-security-policy'], /default-src 'self'/)
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.ok(!res.body.includes(ctx.dir), 'no absolute path in page')
  assert.ok(!res.body.includes(ctx.session.editToken), 'no token in page')
  assert.ok(res.body.includes(ctx.session.epoch))
})

test('wrong Host on plain HTTP -> 421', async () => {
  const res = await get(ctx.port, '/', { host: 'evil.example' })
  assert.equal(res.status, 421)
})

test('non-GET methods -> 404', async () => {
  const res = await new Promise((resolve, reject) => {
    import('node:http').then(({ default: http }) => {
      const req = http.request({ host: '127.0.0.1', port: ctx.port, path: '/', method: 'POST' }, r => { r.resume(); resolve(r.statusCode) })
      req.on('error', reject)
      req.end('x')
    })
  })
  assert.equal(res, 404)
})
