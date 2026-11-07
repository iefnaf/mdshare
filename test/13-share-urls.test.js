// M1: share link construction (.local primary, private IPv4 for the QR).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareUrls } from '../src/electron/shareUrls.js'

const token = 'abc-_123'

test('prefers <LocalHostName>.local, QR uses private IPv4', () => {
  const u = shareUrls({ port: 5123, token, localHostName: 'Alexs-MacBook', hosts: ['100.64.1.2:5123', '192.168.1.20:5123', 'alexs-macbook.local:5123'] })
  assert.equal(u.primary, 'http://alexs-macbook.local:5123/#t=abc-_123')
  assert.equal(u.ip, 'http://192.168.1.20:5123/#t=abc-_123')
})

test('falls back to IP when no LocalHostName', () => {
  const u = shareUrls({ port: 80, token, localHostName: '', hosts: ['10.0.0.5:80'] })
  assert.equal(u.primary, 'http://10.0.0.5:80/#t=abc-_123')
})

test('no LAN IPv4 -> no link (offline)', () => {
  const u = shareUrls({ port: 80, token, localHostName: 'mac', hosts: ['mac.local:80'] })
  assert.equal(u.primary, null)
  assert.equal(u.ip, null)
})

test('token only in the fragment', () => {
  const u = shareUrls({ port: 1, token, localHostName: 'm', hosts: ['192.168.0.2:1'] })
  for (const url of [u.primary, u.ip]) {
    const parsed = new URL(url)
    assert.equal(parsed.search, '')
    assert.equal(parsed.hash, '#t=abc-_123')
  }
})
