// Guest editor: CodeMirror 6 bound to the host's Y.Doc over y-websocket.
// No IndexedDB, no BroadcastChannel: the only copy that outlives this tab is the host's file.
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as decoding from 'lib0/decoding'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { TEXT_KEY, CLOSE, MSG_FROZEN } from '../core/protocol.js'
import { livePreview } from './preview.js'

const VIEW_KEY = 'mdshare-view' // sessionStorage only: per tab, gone when the tab closes

const $ = id => document.getElementById(id)
const meta = name => document.querySelector(`meta[name="${name}"]`)?.content ?? ''

const TERMINAL = new Set([CLOSE.STOPPED, CLOSE.STALE_EPOCH, CLOSE.TOO_LARGE_DOC])
const ENDED = {
  [CLOSE.STOPPED]: ['Sharing stopped', 'The host stopped this session. If editing was paused by a conflict, unsaved changes may not have reached disk.'],
  [CLOSE.STALE_EPOCH]: ['This copy is out of date', 'The host reloaded the document. Reload this page to keep editing the current version.'],
  [CLOSE.TOO_LARGE_DOC]: ['Document too large', 'The last change would make the document larger than 2 MB, so it was not applied.'],
  missing: ['Link incomplete', 'This link is missing its access key. Ask the host for the full link or scan the QR code again.']
}

const COLORS = ['#d1495b', '#2e86ab', '#3a7d44', '#8e5572', '#c17817', '#5c6bc0']

function ended (kind) {
  const [title, text] = ENDED[kind] ?? ['Disconnected', 'The connection to the host was closed.']
  $('ended-title').textContent = title
  $('ended-text').textContent = text
  $('ended').hidden = false
  $('editor').hidden = true
  $('preview').hidden = true
  $('view-toggle').hidden = true
  $('banner').hidden = true
  $('status').textContent = 'Ended'
}

let disposeCurrent = () => {}
let setCurrentMode = () => {}
let mode = 'source'
try { mode = sessionStorage.getItem(VIEW_KEY) === 'preview' ? 'preview' : 'source' } catch {}
const name = `Guest ${Math.floor(Math.random() * 90 + 10)}`
const color = COLORS[Math.floor(Math.random() * COLORS.length)]

$('view-toggle').addEventListener('click', e => {
  const button = e.target.closest('button[data-view]')
  if (button) setCurrentMode(button.dataset.view)
})
$('files').addEventListener('click', e => {
  const button = e.target.closest('button[data-file]')
  if (button && button.getAttribute('aria-current') !== 'page') openFile(button)
})

function openFile (button) {
  disposeCurrent()
  $('editor').replaceChildren()
  $('preview').replaceChildren()
  $('banner').hidden = true
  $('status').textContent = 'Connecting…'
  $('filename').textContent = button.lastElementChild.textContent
  for (const item of $('files').querySelectorAll('button')) item.setAttribute('aria-current', item === button ? 'page' : 'false')

  const token = new URLSearchParams(location.hash.slice(1)).get('t')
  const epoch = meta('mdshare-epoch')
  if (!token || !epoch) return ended('missing')

  const doc = new Y.Doc()
  const ytext = doc.getText(TEXT_KEY)
  const provider = new WebsocketProvider(`ws://${location.host}`, 'ws', doc, {
    params: { e: epoch, t: token, f: button.dataset.file },
    disableBc: true,
    resyncInterval: -1,
    shouldReconnect: ev => !TERMINAL.has(ev?.code)
  })

  let view = null
  let frozen = false

  // Source / Preview. The editor (and yCollab) stays mounted in both modes; only
  // visibility changes, so sync, awareness and freeze handling are unaffected.
  const preview = livePreview($('preview'), ytext)
  const setMode = setCurrentMode = next => {
    mode = next === 'preview' ? 'preview' : 'source'
    $('editor').hidden = mode !== 'source'
    $('preview').hidden = mode !== 'preview'
    for (const b of $('view-toggle').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.view === mode))
    }
    preview.setVisible(mode === 'preview')
    try { sessionStorage.setItem(VIEW_KEY, mode) } catch {} // storage may be disabled
    if (mode === 'source' && view) {
      view.requestMeasure() // it was display:none; layout may be stale
      view.focus()
    }
  }
  setMode(mode)
  const editable = new Compartment()
  const canEdit = () => provider.wsconnected && provider.synced && !frozen

  const refresh = () => {
    if (!view) return
    const on = canEdit()
    view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(on), EditorState.readOnly.of(!on)]) })
    $('status').textContent = frozen ? 'Read-only' : on ? 'Connected' : 'Reconnecting…'
    $('banner').hidden = !frozen && on
    $('banner').textContent = frozen
      ? 'A shared file changed on the host computer, or could not be saved. Editing is paused for this session. Copy any unsaved text before the host restarts sharing.'
      : 'Connection lost. Reconnecting… (edits are paused)'
  }

  provider.messageHandlers[MSG_FROZEN] = (_enc, dec) => {
    frozen = decoding.readVarUint(dec) === 1
    refresh()
  }

  provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '33' })

  provider.on('status', refresh)
  provider.on('sync', isSynced => {
    if (isSynced && !view) {
      undoManager = new Y.UndoManager(ytext)
      view = new EditorView({
        parent: $('editor'),
        state: EditorState.create({
          doc: ytext.toString(),
          extensions: [
            EditorView.cspNonce.of(meta('mdshare-nonce')),
            keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
            drawSelection(),
            highlightActiveLine(),
            EditorView.lineWrapping,
            markdown(),
            syntaxHighlighting(defaultHighlightStyle),
            editable.of([]),
            yCollab(ytext, provider.awareness, { undoManager })
          ]
        })
      })
      if (mode === 'source') view.focus()
    }
    refresh()
  })

  let disposed = false
  let undoManager
  disposeCurrent = () => {
    if (disposed) return
    disposed = true
    provider.off('status', refresh)
    provider.destroy()
    provider.awareness.destroy()
    preview.destroy()
    view?.destroy()
    doc.destroy()
    undoManager?.destroy()
  }
  provider.on('closed', ({ code }) => {
    disposeCurrent()
    ended(code)
    for (const item of $('files').querySelectorAll('button')) item.disabled = true
  })
}

openFile($('files').querySelector('button'))
