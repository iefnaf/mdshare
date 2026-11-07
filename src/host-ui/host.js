// Host window. Talks to the main process only through window.mdshare (preload.cjs).
const $ = id => document.getElementById(id)
const api = window.mdshare
let busy = false
let currentState = { sharing: false }

function render (state) {
  currentState = state
  const sharing = Boolean(state?.sharing)
  document.body.classList.toggle('is-sharing', sharing)
  $('idle').hidden = sharing
  $('sharing').hidden = !sharing
  $('error').hidden = !state?.error
  $('error').textContent = state?.error ?? ''
  $('session-status').textContent = sharing ? (state.frozen ? 'Editing paused' : 'Sharing on your Wi-Fi') : 'Ready to share'
  $('file-count').textContent = String(state.files?.length ?? 0)
  $('file-list').replaceChildren(...(state.files ?? []).map(file => {
    const li = document.createElement('li')
    li.textContent = file.name
    return li
  }))
  if (!sharing) return
  $('connection').hidden = !state.url
  $('link-area').hidden = !state.url
  $('basename').textContent = state.basename
  $('url').textContent = state.url ?? ''
  if (state.qr) $('qr').src = state.qr
  else $('qr').removeAttribute('src')
  const showIp = state.ipUrl && state.ipUrl !== state.url
  $('ip-row').hidden = !showIp
  $('ip-url').textContent = showIp ? state.ipUrl : ''
  $('frozen').hidden = !state.frozen
}

async function run (fn) {
  if (busy) return
  busy = true
  $('drop').setAttribute('aria-busy', 'true')
  $('drop-hint').textContent = 'Opening…'
  for (const button of document.querySelectorAll('button')) button.disabled = true
  try {
    render(await fn())
  } catch (err) {
    render({ ...currentState, error: String(err?.message ?? err) })
  } finally {
    busy = false
    $('drop').setAttribute('aria-busy', 'false')
    $('drop-hint').textContent = 'Drop Markdown files or a folder'
    for (const button of document.querySelectorAll('button')) button.disabled = false
  }
}

// The entire idle window accepts a drop. Track nested drag events so crossing
// the illustration or label does not flicker the active target.
const drop = $('drop')
let dragDepth = 0
const acceptsDrop = () => !currentState.sharing && !busy
const resetDrag = () => {
  dragDepth = 0
  drop.classList.remove('over')
}
window.addEventListener('dragenter', e => {
  e.preventDefault()
  if (!acceptsDrop() || !e.dataTransfer?.types.includes('Files')) return
  dragDepth++
  drop.classList.add('over')
})
window.addEventListener('dragover', e => {
  e.preventDefault() // never navigate to a dropped file
  if (e.dataTransfer) e.dataTransfer.dropEffect = acceptsDrop() ? 'copy' : 'none'
})
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) drop.classList.remove('over')
})
window.addEventListener('dragend', resetDrag)
window.addEventListener('drop', e => {
  e.preventDefault()
  resetDrag()
  if (!acceptsDrop()) return
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) run(() => api.shareDropped(files))
})
// A quiet fallback for keyboard users and people who prefer a file dialog.
drop.addEventListener('click', () => run(api.pick))
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    run(api.pick)
  }
})
$('stop').addEventListener('click', () => run(api.stop))
$('copy').addEventListener('click', async () => {
  await api.copy($('url').textContent)
  $('copy').textContent = 'Copied'
  setTimeout(() => { $('copy').textContent = 'Copy link' }, 1500)
})

api.onState(render)
api.info().then(render)
