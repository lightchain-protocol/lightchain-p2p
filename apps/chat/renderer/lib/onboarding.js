import { copy, toast } from './dom.js'
import { forgetBackupState, markBackedUp, showBackupBanner } from './backup.js'
import { request } from './ipc.js'
import { refreshTitlebarBalance, showWallet } from './wallet.js'

/**
 * First run, and every way back in.
 *
 * The wallet is the identity: rooms are sealed under a key derived from it and
 * inference is paid for by it, so there is nothing meaningful behind this until
 * one exists and is unlocked.
 *
 * The rule this file exists to keep is that **no screen here is terminal**. The
 * version before it broke that rule in a way that made the application
 * unusable: the unlock screen had no exit, removing a wallet required the
 * password somebody had just said they had lost, and the only remove button was
 * in Settings, behind the overlay that would not lift. A forgotten password
 * meant no reachable state anywhere in the app, with nothing on screen
 * admitting it. Anything added here needs a way onward from every state,
 * including the states nobody plans for.
 */

const WORDS_IN_PHRASE = 12
const MIN_PASSWORD = 8
const WORDS_TO_VERIFY = 3

const onboarding = {
  root: document.getElementById('onboarding'),
  steps: [...document.querySelectorAll('.onboarding .step')]
}

/** The phrase, held only between showing it and confirming it. */
let pendingPhrase = null

/**
 * The word the worker will accept to authorise a replacement.
 *
 * Read from `wallet.replacePreview` rather than written here. The renderer is
 * sandboxed and cannot import from the workspace, so quoting the worker is the
 * only way for the two sides to hold one value instead of two literals that
 * drift.
 */
let confirmationWord = null

/** Where "Back" from the restore screen should go, which depends on arrival. */
let restoreReturn = 'step-welcome'

function el(id) {
  return document.getElementById(id)
}

function showStep(id) {
  onboarding.root.hidden = false
  for (const step of onboarding.steps) step.hidden = step.id !== id

  // The dialog is labelled by whichever title is showing, so a screen reader
  // announces the step rather than the first one that ever rendered. Pointing
  // the label at the title's own id — rather than moving one shared id around —
  // is what keeps the document from ending up with nine elements answering to
  // the same name, which is what the first version of this did.
  const step = el(id)
  const title = step?.querySelector('.step-title')
  if (title) onboarding.root.setAttribute('aria-labelledby', title.id)

  for (const error of step?.querySelectorAll('.dialog-error') ?? []) error.hidden = true

  /*
   * A field, or the step itself — never a button.
   *
   * This used to reach for `.choice` and `.button-primary` as well, and
   * focusing a button in code is focus Chromium renders as `:focus-visible`.
   * So every step arrived with a lavender ring drawn tight around its first
   * control, which reads as a white border somebody left on rather than as the
   * keyboard's position. Landing on the step keeps the announcement for a
   * screen reader without putting a ring on anything.
   */
  const field = step?.querySelector('input, textarea')
  if (field) {
    field.focus()
    return
  }

  if (step) {
    step.tabIndex = -1
    step.focus({ preventScroll: true })
  }
}

/**
 * Opens a named step, for the harness that walks this flow.
 *
 * Exported rather than reached at through internals, so a rename here breaks
 * the test loudly instead of leaving it clicking at nothing. It is the same
 * function the flow uses; nothing about the sequence is bypassed by calling it.
 */
export function showStepForTesting(id) {
  showStep(id)
}

function fail(id, message) {
  const error = el(id)
  error.textContent = message
  error.hidden = false
}

function finishOnboarding() {
  // The wallet has just opened, so there is a balance to show for the first
  // time. Locking hides it again, through the same path.
  void refreshTitlebarBalance()
  pendingPhrase = null
  // The phrase is gone, so the controls that act on it have to go back to not
  // offering. Leaving them enabled let a later click reach a null phrase and
  // throw, which is a blank screen with the reason only in the console.
  coverPhrase()
  onboarding.root.hidden = true
  void showBackupBanner()
}

/**
 * Whether a wallet is on disk, asked again rather than remembered.
 *
 * The answer can change while this overlay is open — another window, a harness,
 * a wallet removed in Settings — and a screen offering to create one when one
 * already exists sends somebody into an error they cannot act on. Every branch
 * that depends on it re-reads it.
 */
async function walletExists() {
  const status = await request('wallet.status')
  return status.exists === true
}

/** The confirmation word, fetched once and reused. */
async function replaceWord() {
  if (confirmationWord === null) {
    const preview = await request('wallet.replacePreview')
    confirmationWord = preview.confirmation
  }
  return confirmationWord
}

// --- Create ----------------------------------------------------------------

function renderPhrase(phrase) {
  const list = el('phrase-words')
  list.replaceChildren()
  for (const word of phrase.split(' ')) {
    const item = document.createElement('li')
    item.textContent = word
    list.append(item)
  }
}

/**
 * Asks for three of the twelve words back.
 *
 * Not ceremony: a phrase nobody wrote down correctly is a wallet nobody can
 * recover, and this is the last moment when finding that out is free.
 */
function renderVerify(phrase) {
  const words = phrase.split(' ')
  const positions = []
  while (positions.length < WORDS_TO_VERIFY) {
    const n = Math.floor(Math.random() * words.length)
    if (!positions.includes(n)) positions.push(n)
  }
  positions.sort((a, b) => a - b)

  el('verify-prompt').textContent =
    'Type the words at these positions, to check the copy you wrote down is right.'

  const fields = el('verify-fields')
  fields.replaceChildren()
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
    fields.append(label)
  }
}

el('choose-create').addEventListener('click', () => showStep('step-password'))

el('choose-restore').addEventListener('click', () => {
  restoreReturn = 'step-welcome'
  void openRestore()
})

el('onboard-password').addEventListener('input', (evt) => {
  const hint = el('onboard-password-hint')
  const length = evt.target.value.length
  if (length === 0) {
    hint.textContent = `At least ${MIN_PASSWORD} characters.`
    delete hint.dataset.state
  } else if (length < MIN_PASSWORD) {
    hint.textContent = `${MIN_PASSWORD - length} more to go.`
    hint.dataset.state = 'bad'
  } else {
    hint.textContent = 'Long enough.'
    hint.dataset.state = 'ok'
  }
})

el('onboard-password-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const button = el('onboard-password-btn')
  const password = el('onboard-password').value
  const confirm = el('onboard-password-confirm').value

  el('onboard-password-error').hidden = true
  if (password !== confirm)
    return fail('onboard-password-error', 'Those two passwords are not the same.')
  if (password.length < MIN_PASSWORD) {
    return fail('onboard-password-error', `Use at least ${MIN_PASSWORD} characters.`)
  }

  button.disabled = true
  button.textContent = 'Creating…'

  try {
    const created = await request('wallet.create', { password })
    pendingPhrase = created.phrase
    renderPhrase(created.phrase)
    showWallet(created)
    coverPhrase()

    // The wallet exists from here. Writing the words down is the next thing to
    // do and it is no longer the next thing you are made to do — the step
    // offers both, and choosing Later reaches the application with a banner
    // rather than reaching a dead end.
    forgetBackupState()
    showStep('step-secure')
  } catch (err) {
    // The most likely cause is a wallet that appeared while this screen was
    // open, and the worker's message says so but offers nothing to do about it.
    // Sending them to the screen that has the routes is the actionable part.
    if (await walletExists()) {
      fail('onboard-password-error', `${err.message} You can replace it from the next screen.`)
      showStep('step-recovery')
    } else {
      fail('onboard-password-error', err.message)
    }
  } finally {
    el('onboard-password').value = ''
    el('onboard-password-confirm').value = ''
    button.disabled = false
    button.textContent = 'Continue'
  }
})

el('secure-now').addEventListener('click', () => {
  if (!pendingPhrase) return finishOnboarding()
  coverPhrase()
  showStep('step-phrase')
})

el('secure-later').addEventListener('click', () => {
  // Nothing is recorded. Not backed up is the absence of the record, so a
  // deliberate "later" and a window closed at this exact moment land in the
  // same state — which is the honest one, because neither wrote anything down.
  finishOnboarding()
})

/** Hides the words again, which is the state the step has to open in. */
function coverPhrase() {
  el('phrase-reveal').hidden = false
  el('phrase-copy').disabled = true
  el('phrase-continue').disabled = true
}

el('phrase-reveal').addEventListener('click', () => {
  el('phrase-reveal').hidden = true
  el('phrase-copy').disabled = false
  // Continuing is only offered once the words have actually been on screen,
  // since "I have written it down" is not true of something never shown.
  el('phrase-continue').disabled = false
})

el('phrase-copy').addEventListener('click', () => {
  if (pendingPhrase) void copy(pendingPhrase, 'Recovery phrase')
})

el('phrase-continue').addEventListener('click', () => {
  // Belt as well as braces. The button is disabled without a phrase, but a
  // disabled button is a claim about the DOM and this is a claim about the
  // data, and the two have already disagreed once.
  if (!pendingPhrase) return showStep('step-welcome')
  renderVerify(pendingPhrase)
  showStep('step-verify')
})

el('verify-back').addEventListener('click', () => {
  coverPhrase()
  showStep('step-phrase')
})

el('verify-form').addEventListener('submit', (evt) => {
  evt.preventDefault()
  const words = pendingPhrase.split(' ')

  for (const input of el('verify-fields').querySelectorAll('input')) {
    const position = Number(input.dataset.position)
    if (input.value.trim().toLowerCase() !== words[position]) {
      return fail('verify-error', `Word ${position + 1} does not match. Check what you wrote down.`)
    }
  }

  el('verify-error').hidden = true
  // Recorded here rather than on the screen that showed the words. Seeing them
  // is not writing them down; typing three back from memory is the closest this
  // can get to evidence that they left the machine.
  void markBackedUp('written down during setup')
  finishOnboarding()
  toast('Wallet ready')
})

// --- Restore ---------------------------------------------------------------

/**
 * Opens the restore screen, telling it whether it is replacing something.
 *
 * Restoring over an existing wallet is the recommended way back in for somebody
 * who has lost their password, so it must not be refused — but it must also not
 * happen quietly, hence the note.
 */
async function openRestore() {
  const replacing = await walletExists()
  el('restore-replacing').hidden = !replacing
  el('restore-btn').textContent = replacing ? 'Replace and restore' : 'Restore'
  showStep('step-restore')
}

el('restore-back').addEventListener('click', () => showStep(restoreReturn))

el('restore-phrase').addEventListener('input', (evt) => {
  const hint = el('restore-count')
  const words = evt.target.value.trim().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    hint.textContent = `${WORDS_IN_PHRASE} words.`
    delete hint.dataset.state
  } else if (words.length === WORDS_IN_PHRASE) {
    hint.textContent = `${WORDS_IN_PHRASE} words.`
    hint.dataset.state = 'ok'
  } else {
    // Counting out loud catches the overwhelmingly common mistake — a missing
    // or doubled word — before it comes back as "that phrase is not valid",
    // which does not say which of the twelve to look at.
    hint.textContent = `${words.length} of ${WORDS_IN_PHRASE} words.`
    hint.dataset.state = 'bad'
  }
})

/**
 * Shows which wallet the phrase and passphrase together would open.
 *
 * The only check available. A wrong passphrase is not an error — it derives a
 * different, valid, empty wallet — so the address is the one thing somebody can
 * recognise before committing to it. Shown only while the passphrase field is
 * in use, because for everyone else it is a hex string with no question
 * attached.
 */
async function previewRestore() {
  const preview = el('restore-preview')
  const phrase = el('restore-phrase').value
  const passphrase = el('restore-passphrase').value

  if (passphrase === '' || phrase.trim().split(/\s+/).filter(Boolean).length !== WORDS_IN_PHRASE) {
    preview.hidden = true
    return
  }

  try {
    const { address } = await request('wallet.previewImport', { phrase, passphrase })
    preview.textContent = `This opens ${address}. Restore only if you recognise it.`
    preview.dataset.state = 'ok'
  } catch {
    // An invalid phrase is already reported by the word count above, and the
    // submit will say so properly. Nothing useful to add here.
    preview.textContent = ''
    preview.hidden = true
    return
  }

  preview.hidden = false
}

el('restore-passphrase').addEventListener('input', previewRestore)
el('restore-phrase').addEventListener('input', previewRestore)

el('restore-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const button = el('restore-btn')
  const phrase = el('restore-phrase').value
  const password = el('restore-password').value
  const passphrase = el('restore-passphrase').value
  const label = button.textContent

  el('restore-error').hidden = true
  if (password.length < MIN_PASSWORD) {
    return fail('restore-error', `Use at least ${MIN_PASSWORD} characters for the password.`)
  }

  button.disabled = true
  button.textContent = 'Restoring…'

  try {
    // The confirmation is only meaningful when something is being replaced, and
    // the worker ignores it otherwise. Sending it either way keeps this path
    // from depending on a check made a moment ago in another screen.
    const restored = await request('wallet.import', {
      phrase,
      password,
      passphrase,
      confirmation: await replaceWord()
    })

    showWallet(restored)
    // Somebody who just typed twelve words demonstrably has them. Asking them
    // to back up a phrase they restored from would be asking them to copy out
    // what is already in their hand.
    forgetBackupState()
    void markBackedUp('restored from a phrase')

    el('restore-phrase').value = ''
    el('restore-passphrase').value = ''
    el('restore-preview').hidden = true
    finishOnboarding()
    toast(restored.replaced ? 'Wallet replaced' : 'Wallet restored')
  } catch (err) {
    fail('restore-error', err.message)
  } finally {
    el('restore-password').value = ''
    button.disabled = false
    button.textContent = label
  }
})

// --- Unlock, and the ways out of it ----------------------------------------

el('unlock-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const button = el('unlock-btn')
  const input = el('unlock-password')

  el('unlock-error').hidden = true
  button.disabled = true
  button.textContent = 'Unlocking…'

  try {
    showWallet(await request('wallet.unlock', { password: input.value }))
    finishOnboarding()
  } catch (err) {
    fail('unlock-error', err.message)
  } finally {
    input.value = ''
    button.disabled = false
    button.textContent = 'Unlock'
  }
})

el('unlock-forgot').addEventListener('click', () => showStep('step-recovery'))

el('recover-phrase').addEventListener('click', () => {
  restoreReturn = 'step-recovery'
  void openRestore()
})

el('recover-password').addEventListener('click', () => showStep('step-remove'))
el('recover-neither').addEventListener('click', () => void openStartOver())

el('remove-wallet-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const button = el('remove-wallet-btn')
  const input = el('remove-wallet-password')

  el('remove-wallet-error').hidden = true
  button.disabled = true
  button.textContent = 'Removing…'

  try {
    showWallet(await request('wallet.remove', { password: input.value }))
    toast('Wallet removed')
    showStep('step-welcome')
  } catch (err) {
    fail('remove-wallet-error', err.message)
  } finally {
    input.value = ''
    button.disabled = false
    button.textContent = 'Remove wallet'
  }
})

// --- Starting over, with neither ------------------------------------------

/**
 * The last resort, gated by typing rather than by a password.
 *
 * Requiring the password here would be circular: this screen exists precisely
 * for somebody who does not have it. The vault is encrypted and deleting it
 * discloses nothing, and anyone who can reach the file could delete it without
 * the app — so a password would not be protecting the secret, only trapping its
 * owner. What is actually at risk is somebody destroying their own wallet
 * without understanding it, and the guard for that is informed consent: a
 * sentence naming what is lost, and a word typed out by hand.
 */
async function openStartOver() {
  const word = await replaceWord()
  // The label carries the word and the box stays empty. A placeholder showing
  // the word to type reads as a box that is already filled in, which is the one
  // impression a confirmation must never give.
  el('startover-label').textContent = `Type ${word} to confirm`
  el('startover-confirm').value = ''
  el('startover-btn').disabled = true
  showStep('step-startover')
}

el('startover-confirm').addEventListener('input', (evt) => {
  el('startover-btn').disabled = evt.target.value !== confirmationWord
})

el('startover-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const button = el('startover-btn')
  el('startover-error').hidden = true
  button.disabled = true
  button.textContent = 'Starting over…'

  try {
    showWallet(await request('wallet.remove', { confirmation: el('startover-confirm').value }))
    toast('Wallet removed')
    showStep('step-welcome')
  } catch (err) {
    fail('startover-error', err.message)
    button.disabled = false
  } finally {
    el('startover-confirm').value = ''
    button.textContent = 'Start over'
  }
})

// --- Shared controls -------------------------------------------------------

for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => showStep(button.dataset.back))
}

// A password box somebody cannot read is a password box somebody mistypes, and
// on this screen a mistyped one is set for good with no way to check it.
for (const button of document.querySelectorAll('[data-reveal]')) {
  button.addEventListener('click', () => {
    const input = el(button.dataset.reveal)
    const shown = input.type === 'text'
    input.type = shown ? 'password' : 'text'
    button.textContent = shown ? 'Show' : 'Hide'
    input.focus()
  })
}

/**
 * Decides what the app opens on.
 *
 * The wallet is the identity, so there is nothing meaningful behind this until
 * one exists and is unlocked.
 */
export async function startOnboarding() {
  const status = await request('wallet.status')
  showWallet(status)

  if (!status.exists) showStep('step-welcome')
  else if (!status.unlocked) showStep('step-unlock')
  else finishOnboarding()
}
