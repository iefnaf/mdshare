// Loads the prebuilt guest bundle (scripts/build-guest.js -> dist/guest) into memory
// and renders the guest page. Nothing is served from disk at request time.
import fs from 'node:fs'
import path from 'node:path'
import { escapeHtml } from './SyncServer.js'

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

/**
 * @param {string} dir  directory containing manifest.json and the hashed files it names
 * @returns {{assets: Map<string,{type:string,body:Buffer}>, renderIndex: Function, manifest: {js:string, css:string}}}
 */
export function loadGuestAssets (dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const assets = new Map()
  for (const name of [manifest.js, manifest.css]) {
    if (path.basename(name) !== name) throw new Error(`bad asset name in manifest: ${name}`)
    assets.set(name, { type: TYPES[path.extname(name)], body: fs.readFileSync(path.join(dir, name)) })
  }
  const renderIndex = (session, { nonce }) => guestHtml({ manifest, session, nonce })
  return { assets, renderIndex, manifest }
}

/**
 * The epoch is embedded per page load (not secret, changes on "Load disk version");
 * the edit token is only ever in the URL fragment, which browsers never send to the server.
 */
export function guestHtml ({ manifest, session, nonce }) {
  const title = escapeHtml(session.title ?? 'Shared document')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="mdshare-epoch" content="${escapeHtml(session.epoch)}">
<meta name="mdshare-nonce" content="${escapeHtml(nonce)}">
<title>${title}</title>
<link rel="stylesheet" href="/assets/${escapeHtml(manifest.css)}">
</head>
<body>
<header class="bar">
  <span class="name">${title}</span>
  <div id="view-toggle" class="toggle" role="group" aria-label="View">
    <button id="view-source" type="button" data-view="source" aria-pressed="true">Source</button>
    <button id="view-preview" type="button" data-view="preview" aria-pressed="false">Preview</button>
  </div>
  <span id="status" class="status" role="status">Connecting…</span>
</header>
<div id="banner" class="banner" hidden></div>
<main id="editor" class="editor" aria-label="Markdown editor"></main>
<article id="preview" class="preview" hidden aria-label="Markdown preview"></article>
<div id="ended" class="ended" hidden><div class="card"><h1 id="ended-title"></h1><p id="ended-text"></p></div></div>
<script src="/assets/${escapeHtml(manifest.js)}"></script>
</body>
</html>`
}
