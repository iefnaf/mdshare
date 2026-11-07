// Host window. Talks to the main process only through window.mdshare (preload.cjs).
const $ = id => document.getElementById(id)
const api = window.mdshare
let busy = false

function render (state) {
  const sharing = Boolean(state?.sharing)
  $('idle').hidden = sharing
  $('sharing').hidden = !sharing
  $('error').hidden = !state?.error
  $('error').textContent = state?.error ?? ''
  if (!sharing) return
  $('basename').textContent = state.basename
  $('url').textContent = state.url
  $('qr').src = state.qr
  const showIp = state.ipUrl && state.ipUrl !== state.url
  $('ip-row').hidden = !showIp
  $('ip-url').textContent = showIp ? state.ipUrl : ''
  $('frozen').hidden = !state.frozen
}

async function run (fn) {
  if (busy) return
  busy = true
  try {
    render(await fn())
  } catch (err) {
    render({ sharing: false, error: String(err?.message ?? err) })
  } finally {
    busy = false
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
  if (files.length !== 1) return render({ sharing: false, error: 'Drop one Markdown file.' })
  run(() => api.shareDropped(files[0]))
})
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(api.pick) }
})
$('pick').addEventListener('click', e => { e.stopPropagation(); run(api.pick) })
$('stop').addEventListener('click', () => run(api.stop))
$('copy').addEventListener('click', async () => {
  await api.copy($('url').textContent)
  $('copy').textContent = 'Copied'
  setTimeout(() => { $('copy').textContent = 'Copy' }, 1500)
})

api.onState(render)
api.info().then(render)
