import { copy, toast } from './dom.js'
import { bridge, request } from './ipc.js'
import { refreshWallet, showWallet } from './wallet.js'
import { startOnboarding } from './onboarding.js'

/**
 * One panel for the whole application.
 *
 * A section shows what is happening; this is the only place anything is
 * configured. Every field shows both what is stored and what it resolves to,
 * because almost all of them are optional and fall through to an environment
 * variable — a form showing only the stored half looks empty on a machine that
 * is fully set up.
 */

const settings = {
  root: document.getElementById('settings'),
  pages: [...document.querySelectorAll('.settings-page')],
  tabs: [...document.querySelectorAll('[data-settings]')]
}

/** Which page is showing, so that saving something does not navigate away from it. */
let settingsPage = 'general'

function showSettingsPage(name) {
  settingsPage = name
  for (const tab of settings.tabs) tab.classList.toggle('is-active', tab.dataset.settings === name)
  for (const page of settings.pages) page.hidden = page.id !== `settings-${name}`
}

for (const tab of settings.tabs) {
  tab.addEventListener('click', () => showSettingsPage(tab.dataset.settings))
}

function facts(target, pairs) {
  target.replaceChildren()
  for (const [term, value] of pairs) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value ?? 'not set'
    target.append(dt, dd)
  }
}

/**
 * @param {string} [page]
 *   Defaults to whatever was last showing. Several callers reopen this purely
 *   to reload the values after a save, and sending them back to General each
 *   time would navigate away from the thing they just edited.
 */
export async function openSettings(page = settingsPage) {
  settings.root.hidden = false
  showSettingsPage(page)

  const state = await request('settings.read')

  document.getElementById('set-network').value = state.effective.network
  facts(document.getElementById('network-facts'), [
    ['RPC', state.effective.rpcUrl],
    ['Chain ID', String(state.effective.chainId)]
  ])

  // The password is deliberately not returned, so the field shows whether one
  // exists rather than what it is.
  const password = document.getElementById('set-worker-password')
  password.value = ''
  password.placeholder = state.workerPasswordSet ? 'Set — type to replace' : 'Not set'

  document.getElementById('set-keys-dir').value = state.values.keysDir ?? ''
  document.getElementById('set-keys-dir').placeholder = state.effective.keysDir ?? ''
  document.getElementById('set-container').value = state.values.containerName ?? ''
  document.getElementById('set-container').placeholder = state.effective.containerName ?? ''
  document.getElementById('set-models').value = state.values.supportedModels ?? ''
  document.getElementById('set-models').placeholder = (state.effective.supportedModels ?? []).join(
    ', '
  )
  document.getElementById('set-ollama').value = state.values.ollamaUrl ?? ''
  document.getElementById('set-ollama').placeholder = state.effective.ollamaUrl ?? ''

  document.getElementById('set-blind-peers').value = state.values.blindPeers ?? ''
  document.getElementById('blind-status').textContent =
    state.blindPeerCount > 0
      ? `${state.blindPeerCount} blind peer${state.blindPeerCount === 1 ? '' : 's'} in use. Rooms opened from now on are lodged with them.`
      : 'No blind peers. Rooms live only while someone who has them is online.'

  document.getElementById('dht-key').textContent = state.dhtKey ?? ''

  // Reported, not interpreted. Zero peers is normal when nobody else is online
  // and is also what a blocked machine looks like, so this says the number and
  // leaves the conclusion alone — but having the number at all is the
  // difference between checking and guessing.
  const net = await request('net.status').catch(() => null)
  facts(document.getElementById('storage-facts'), [
    ['Directory', state.storage],
    ['Version', bridge.pkg().version],
    [
      'Peers',
      net === null
        ? 'unknown'
        : `${net.connections} connected, across ${net.rooms} room${net.rooms === 1 ? '' : 's'}`
    ]
  ])
}

document.getElementById('dht-copy').addEventListener('click', () => {
  void copy(document.getElementById('dht-key').textContent, 'Key')
})

document.getElementById('blind-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('blind-error')
  error.hidden = true

  try {
    await request('settings.write', {
      values: { blindPeers: document.getElementById('set-blind-peers').value.trim() }
    })
    // Rooms are lodged as they open, so existing ones are unaffected until the
    // app restarts. Saying so beats letting someone believe otherwise.
    toast('Saved. Restart to lodge rooms you already have.')
    void openSettings()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  }
})

document.getElementById('settings-btn').addEventListener('click', () => void openSettings())
document.getElementById('settings-close').addEventListener('click', () => {
  settings.root.hidden = true
})

document.getElementById('set-network').addEventListener('change', async (evt) => {
  try {
    await request('settings.write', { values: { network: evt.target.value } })
    toast(`Now using ${evt.target.value}`)
    void refreshWallet()
    void openSettings()
  } catch (err) {
    toast(err.message, 'error')
  }
})

document.getElementById('worker-settings-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('worker-settings-error')
  error.hidden = true

  const password = document.getElementById('set-worker-password').value

  try {
    await request('settings.write', {
      values: {
        // Left blank means "leave it alone", not "clear it" — otherwise
        // opening settings and saving anything would wipe the password.
        ...(password === '' ? {} : { workerPassword: password }),
        keysDir: document.getElementById('set-keys-dir').value.trim(),
        containerName: document.getElementById('set-container').value.trim(),
        supportedModels: document.getElementById('set-models').value.trim(),
        ollamaUrl: document.getElementById('set-ollama').value.trim()
      }
    })
    document.getElementById('set-worker-password').value = ''
    toast('Saved')
    void openSettings()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  }
})

document.getElementById('reveal-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('reveal-error')
  const list = document.getElementById('reveal-phrase')
  const input = document.getElementById('reveal-password')
  error.hidden = true

  try {
    const { phrase } = await request('wallet.reveal', { password: input.value })
    list.replaceChildren()
    for (const word of phrase.split(' ')) {
      const item = document.createElement('li')
      item.textContent = word
      list.append(item)
    }
    list.hidden = false
  } catch (err) {
    list.hidden = true
    error.textContent = err.message
    error.hidden = false
  } finally {
    input.value = ''
  }
})

document.getElementById('password-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('password-error')
  const button = document.getElementById('password-btn')
  const current = document.getElementById('password-current')
  const next = document.getElementById('password-next')
  const confirm = document.getElementById('password-confirm')
  error.hidden = true

  if (next.value !== confirm.value) {
    error.textContent = 'Those two passwords are not the same.'
    error.hidden = false
    return
  }

  button.disabled = true
  // Half a second of scrypt each way, so this is not instant and should not
  // look like nothing happened.
  button.textContent = 'Changing…'

  try {
    await request('wallet.changePassword', { current: current.value, next: next.value })
    toast('Password changed')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    for (const field of [current, next, confirm]) field.value = ''
    button.disabled = false
    button.textContent = 'Change password'
  }
})

document.getElementById('remove-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('remove-error')
  const input = document.getElementById('remove-password')
  error.hidden = true

  try {
    showWallet(await request('wallet.remove', { password: input.value }))
    settings.root.hidden = true
    // Back to first run, because there is no identity any more.
    await startOnboarding()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    input.value = ''
  }
})
