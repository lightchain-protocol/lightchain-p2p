import { copy, toast } from './dom.js'
import { request } from './ipc.js'
import { refreshTitlebarBalance, showWallet } from './wallet.js'

/**
 * First run, which covers everything.
 *
 * The wallet is the identity: rooms are sealed under a key derived from it and
 * inference is paid for by it, so there is nothing meaningful behind this until
 * one exists and is unlocked.
 */

const onboarding = {
  root: document.getElementById('onboarding'),
  steps: [...document.querySelectorAll('.onboarding .step')],
  phraseWords: document.getElementById('phrase-words'),
  confirmPrompt: document.getElementById('confirm-prompt'),
  confirmFields: document.getElementById('confirm-fields'),
  confirmError: document.getElementById('confirm-error')
}

/** The phrase, held only between showing it and confirming it. */
let pendingPhrase = null
let pendingChecks = []

function showStep(id) {
  onboarding.root.hidden = false
  for (const step of onboarding.steps) step.hidden = step.id !== id
  const focusable = document.querySelector(`#${id} input, #${id} textarea, #${id} .button-primary`)
  focusable?.focus()
}

function finishOnboarding() {
  // The wallet has just opened, so there is a balance to show for the first
  // time. Locking hides it again, through the same path.
  void refreshTitlebarBalance()
  pendingPhrase = null
  onboarding.root.hidden = true
}

function renderPhrase(phrase) {
  onboarding.phraseWords.replaceChildren()
  for (const word of phrase.split(' ')) {
    const item = document.createElement('li')
    item.textContent = word
    onboarding.phraseWords.append(item)
  }
}

/**
 * Asks for three of the twelve words back.
 *
 * Not ceremony: a phrase nobody wrote down correctly is a wallet nobody can
 * recover, and this is the last moment when finding that out is free.
 */
function renderConfirm(phrase) {
  const words = phrase.split(' ')
  const positions = []
  while (positions.length < 3) {
    const n = Math.floor(Math.random() * words.length)
    if (!positions.includes(n)) positions.push(n)
  }
  positions.sort((a, b) => a - b)
  pendingChecks = positions

  onboarding.confirmPrompt.textContent =
    'Type the words at these positions, to check the copy you wrote down is right.'

  onboarding.confirmFields.replaceChildren()
  for (const position of positions) {
    const label = document.createElement('label')
    label.className = 'field'

    const caption = document.createElement('span')
    caption.className = 'field-label'
    caption.textContent = `Word ${position + 1}`

    const input = document.createElement('input')
    input.className = 'input'
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.dataset.position = String(position)

    label.append(caption, input)
    onboarding.confirmFields.append(label)
  }
}

document.getElementById('choose-create').addEventListener('click', () => showStep('step-password'))
document.getElementById('choose-import').addEventListener('click', () => showStep('step-import'))
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => showStep(button.dataset.back))
}

document.getElementById('onboard-password-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('onboard-password-error')
  const button = document.getElementById('onboard-password-btn')
  const password = document.getElementById('onboard-password').value
  const confirm = document.getElementById('onboard-confirm').value

  error.hidden = true
  if (password !== confirm) {
    error.textContent = 'Those two passwords are not the same.'
    error.hidden = false
    return
  }
  if (password.length < 8) {
    error.textContent = 'Use at least 8 characters.'
    error.hidden = false
    return
  }

  button.disabled = true
  button.textContent = 'Creating…'

  try {
    const created = await request('wallet.create', { password })
    pendingPhrase = created.phrase
    renderPhrase(created.phrase)
    showWallet(created)
    showStep('step-phrase')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    document.getElementById('onboard-password').value = ''
    document.getElementById('onboard-confirm').value = ''
    button.disabled = false
    button.textContent = 'Continue'
  }
})

document.getElementById('phrase-copy').addEventListener('click', () => {
  if (pendingPhrase) void copy(pendingPhrase, 'Recovery phrase')
})

document.getElementById('phrase-continue').addEventListener('click', () => {
  renderConfirm(pendingPhrase)
  showStep('step-confirm')
})

document.getElementById('confirm-back').addEventListener('click', () => showStep('step-phrase'))

document.getElementById('confirm-form').addEventListener('submit', (evt) => {
  evt.preventDefault()
  const words = pendingPhrase.split(' ')

  for (const input of onboarding.confirmFields.querySelectorAll('input')) {
    const position = Number(input.dataset.position)
    if (input.value.trim().toLowerCase() !== words[position]) {
      onboarding.confirmError.textContent = `Word ${position + 1} does not match. Check what you wrote down.`
      onboarding.confirmError.hidden = false
      return
    }
  }

  onboarding.confirmError.hidden = true
  finishOnboarding()
  toast('Wallet ready')
})

document.getElementById('import-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('import-error')
  const button = document.getElementById('import-btn')
  const phrase = document.getElementById('import-phrase').value
  const password = document.getElementById('import-password').value

  error.hidden = true
  if (password.length < 8) {
    error.textContent = 'Use at least 8 characters for the password.'
    error.hidden = false
    return
  }

  button.disabled = true
  button.textContent = 'Restoring…'

  try {
    showWallet(await request('wallet.import', { phrase, password }))
    document.getElementById('import-phrase').value = ''
    finishOnboarding()
    toast('Wallet restored')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    document.getElementById('import-password').value = ''
    button.disabled = false
    button.textContent = 'Restore'
  }
})

document.getElementById('onboard-unlock-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('onboard-unlock-error')
  const button = document.getElementById('onboard-unlock-btn')
  const input = document.getElementById('onboard-unlock-password')

  error.hidden = true
  button.disabled = true
  button.textContent = 'Unlocking…'

  try {
    showWallet(await request('wallet.unlock', { password: input.value }))
    finishOnboarding()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    input.value = ''
    button.disabled = false
    button.textContent = 'Unlock'
  }
})

/**
 * Decides what the app opens on.
 *
 * The wallet is the identity, so there is nothing meaningful behind this until
 * one exists and is unlocked.
 */
export async function startOnboarding() {
  const status = await request('wallet.status')
  showWallet(status)

  if (!status.exists) showStep('step-choose')
  else if (!status.unlocked) showStep('step-unlock')
  else finishOnboarding()
}
