// Electron main process: one window, one Host. Closing the app stops sharing.
import { app, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { Host, lanHosts } from '../core/Host.js'
import { FileError } from '../core/FileStore.js'
import { shareUrls } from './shareUrls.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = app.getAppPath()
const UI_FILE = path.join(here, '../host-ui/index.html')
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd'])

let win = null
let host = null
let localHostName = ''
let lastState = { sharing: false }

app.enableSandbox()
if (!app.requestSingleInstanceLock()) app.quit()

/** macOS LocalHostName (what mDNSResponder advertises as <name>.local, PLAN G4). */
async function getLocalHostName () {
  try {
    const { stdout } = await promisify(execFile)('/usr/sbin/scutil', ['--get', 'LocalHostName'])
    return stdout.trim()
  } catch {
    return ''
  }
}

const configFile = () => path.join(app.getPath('userData'), 'config.json')
async function readConfig () {
  try { return JSON.parse(await fs.readFile(configFile(), 'utf8')) } catch { return {} }
}
async function writeConfig (cfg) {
  await fs.mkdir(path.dirname(configFile()), { recursive: true })
  await fs.writeFile(configFile(), JSON.stringify(cfg, null, 2))
}

/** Random port, persisted per install so the link stays the same across restarts. */
async function listen () {
  const cfg = await readConfig()
  try {
    if (cfg.port) return await host.listen(cfg.port, '0.0.0.0')
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
  }
  const addr = await host.listen(0, '0.0.0.0')
  await writeConfig({ ...cfg, port: addr.port })
  return addr
}

function send (state) {
  lastState = state
  win?.webContents.send('share:state', state)
}

async function shareInfo () {
  const s = host.session
  if (!s) return { sharing: false }
  const urls = shareUrls({ port: host.port, token: s.editToken, localHostName, hosts: lanHosts(host.port, localHostName) })
  if (!urls.primary) return { sharing: false, error: 'No network connection. Connect to Wi-Fi and try again.' }
  return {
    sharing: true,
    basename: host.store.basename,
    port: host.port,
    url: urls.primary,
    ipUrl: urls.ip,
    qr: await QRCode.toDataURL(urls.ip ?? urls.primary, { margin: 1, width: 240, errorCorrectionLevel: 'M' }),
    frozen: s.frozen,
    warnings: host.store.warnings
  }
}

async function shareFile (filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Not a file path')
  if (!MD_EXT.has(path.extname(filePath).toLowerCase())) {
    return send({ sharing: false, error: 'Only Markdown files (.md) can be shared.' })
  }
  try {
    const session = await host.shareFile(filePath)
    session.on('frozen', async () => send(await shareInfo()))
    session.on('stopped', () => send({ sharing: false }))
    send(await shareInfo())
  } catch (err) {
    const messages = {
      NOT_UTF8: 'This file is not UTF-8 text, so it can’t be shared yet.',
      BINARY: 'This file contains binary data, so it can’t be shared.',
      TOO_LARGE: 'This file is larger than 2 MB, so it can’t be shared.',
      NOT_FILE: 'That is not a regular file.'
    }
    const msg = err instanceof FileError ? messages[err.code] ?? err.message : `Couldn’t open the file: ${err.message}`
    send({ sharing: false, error: msg })
  }
}

/** Only our own bundled page may call the IPC API. */
function fromOurPage (event) {
  const url = event.senderFrame?.url ?? ''
  return url.startsWith('file://') && fileURLToPath(url) === UI_FILE
}
function handle (channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('forbidden')
    return fn(...args)
  })
}

function createWindow () {
  win = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 520,
    title: 'mdshare',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.webContents.on('will-navigate', e => e.preventDefault()) // dropping a file must not navigate
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
  win.loadFile(UI_FILE)
}

app.whenReady().then(async () => {
  localHostName = await getLocalHostName()
  host = new Host({
    backupRoot: path.join(app.getPath('userData'), 'backups'),
    allowedHosts: port => lanHosts(port, localHostName),
    guestDir: path.join(appRoot, 'dist', 'guest')
  })
  await listen()

  handle('share:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a Markdown file to share',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }]
    })
    if (!res.canceled && res.filePaths[0]) await shareFile(res.filePaths[0])
    return lastState
  })
  handle('share:path', async p => { await shareFile(p); return lastState })
  handle('share:stop', async () => { await host.stopSharing(); send({ sharing: false }); return lastState })
  handle('share:info', async () => (host.session ? shareInfo() : lastState))
  handle('share:copy', text => clipboard.writeText(String(text)))

  createWindow()
})

// Closing the window quits the app, and quitting stops sharing (owner decision).
app.on('window-all-closed', () => app.quit())
let quitting = false
app.on('before-quit', e => {
  if (quitting || !host) return
  e.preventDefault()
  quitting = true
  host.close().catch(() => {}).finally(() => app.exit(0))
})
app.on('second-instance', () => { win?.show(); win?.focus() })
