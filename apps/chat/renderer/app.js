const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

// Drives the platform-specific rules in the stylesheet: title bar inset for the
// macOS traffic lights, and the system font for each OS.
document.documentElement.dataset.platform = bridge.platform()

const statusEl = document.getElementById('status')
const versionEl = document.getElementById('version')
const updateBtn = document.getElementById('update-btn')

versionEl.textContent = `v${bridge.pkg().version}`

function setStatus(text) {
  statusEl.textContent = text
}

function showUpdateReady() {
  setStatus('update ready')
  updateBtn.hidden = false
  updateBtn.onclick = async () => {
    updateBtn.disabled = true
    updateBtn.textContent = 'Updating…'
    try {
      await bridge.applyUpdate()
      await bridge.appAfterUpdate()
    } catch (err) {
      setStatus(`update failed: ${err.message}`)
      updateBtn.hidden = true
    }
  }
}

function onWorkerUpdaterEvent(name) {
  if (name === 'updating') setStatus('downloading update')
  if (name === 'updated') showUpdateReady()
}

const workers = { main: '/workers/main.js' }

bridge.startWorker(workers.main)
setStatus('connecting')

const offStdout = bridge.onWorkerStdout(workers.main, (data) => {
  console.log('[worker]', decoder.decode(data))
})

const offStderr = bridge.onWorkerStderr(workers.main, (data) => {
  console.error('[worker]', decoder.decode(data))
})

const offIpc = bridge.onWorkerIPC(workers.main, (data) => {
  const message = decoder.decode(data)
  onWorkerUpdaterEvent(message)
  setStatus('connected')
})

const offExit = bridge.onWorkerExit(workers.main, (code) => {
  // The worker is the data plane. Without it the window is an empty shell, so
  // say so rather than looking idle.
  setStatus(code === 0 ? 'worker stopped' : `worker exited (${code})`)
  offStdout()
  offStderr()
  offIpc()
  offExit()
})
