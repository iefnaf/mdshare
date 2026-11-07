// Host window. Talks to the main process only through window.mdshare (preload.cjs).
const $ = id => document.getElementById(id)
const api = window.mdshare
let busy = false
let currentState = { sharing: false }

function render (state) {
  currentState = state
  const sharing = Boolean(state?.sharing)
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
  for (const button of document.querySelectorAll('button')) button.disabled = true
  try {
    render(await fn())
  } catch (err) {
    render({ ...currentState, error: String(err?.message ?? err) })
  } finally {
    busy = false
    for (const button of document.querySelectorAll('button')) button.disabled = false
  }
}

// Never let a drop anywhere navigate the window to the file.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, e => e.preventDefault())
}

const drop = $('drop')
drop.addEventListener('dragenter', () => drop.classList.add('over'))
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', e => {
  drop.classList.remove('over')
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) run(() => api.shareDropped(files))
})
$('pick').addEventListener('click', e => { e.stopPropagation(); run(api.pick) })
$('pick-folder').addEventListener('click', () => run(api.pickFolder))
$('stop').addEventListener('click', () => run(api.stop))
$('copy').addEventListener('click', async () => {
  await api.copy($('url').textContent)
  $('copy').textContent = 'Copied'
  setTimeout(() => { $('copy').textContent = 'Copy link' }, 1500)
})

api.onState(render)
api.info().then(render)
