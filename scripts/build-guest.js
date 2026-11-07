// Bundles the guest editor into content-hashed files + manifest.json under dist/guest.
// The server serves exactly the files named in the manifest, from memory.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist', 'guest')
const hash = buf => createHash('sha256').update(buf).digest('hex').slice(0, 12)

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/guest/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari15', 'chrome100', 'firefox100'],
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning'
})
const js = Buffer.from(result.outputFiles[0].contents)
const css = await fs.readFile(path.join(root, 'src/guest/guest.css'))
const logo = await fs.readFile(path.join(root, 'src/assets/logo-e.png'))

await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })
const manifest = { js: `guest-${hash(js)}.js`, css: `guest-${hash(css)}.css`, logo: `logo-e-${hash(logo)}.png` }
await fs.writeFile(path.join(out, manifest.js), js)
await fs.writeFile(path.join(out, manifest.css), css)
await fs.writeFile(path.join(out, manifest.logo), logo)
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`guest bundle: ${manifest.js} (${(js.length / 1024).toFixed(0)} KB), ${manifest.css}`)
