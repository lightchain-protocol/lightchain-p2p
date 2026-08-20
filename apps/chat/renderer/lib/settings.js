import { copy, formatLcai, toast } from './dom.js'
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

  // Started rather than awaited, and deliberately not part of the sequence
  // below: it shares nothing with `settings.read`, it answers for itself when a
  // handler is missing, and a slow round trip for it should not hold up the
  // page somebody is actually looking at.
  void refreshInference()

  const state = await request('settings.read')

  document.getElementById('set-network').value = state.effective.network
  facts(document.getElementById('network-facts'), [
    ['RPC', state.effective.rpcUrl],
    ['Chain ID', String(state.effective.chainId)]
  ])

  // Whole minutes. The worker holds it in milliseconds because that is what a
  // clock deals in, and nobody choosing a lock time thinks that way.
  const status = await request('wallet.status')
  document.getElementById('set-auto-lock').value = String(Math.round(status.autoLockMs / 60_000))

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

  // Two different facts, and conflating them is how this told people something
  // untrue. The field is what is *saved*; the count is what the worker is
  // actually using, which it built at boot and does not rebuild. Saving keys
  // and reading "0 in use" is correct rather than broken, and the sentence has
  // to say so or the next person assumes a bug.
  const saved = state.values.blindPeers ?? ''
  const inUse = state.blindPeerCount ?? 0
  document.getElementById('set-blind-peers').value = saved

  document.getElementById('blind-status').textContent =
    inUse > 0
      ? `${inUse} blind peer${inUse === 1 ? '' : 's'} in use. Rooms opened since this app started are lodged with them.`
      : saved.trim() !== ''
        ? 'Saved, but not in use yet. The app has to restart before it will lodge anything.'
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
    // The worker builds its blind-peer registry once, at boot, so saving keys
    // changes nothing at all until it restarts — not even for rooms opened
    // afterwards. The previous wording promised those would be lodged, which
    // was the sentence somebody would have trusted right up until a room they
    // thought was safe disappeared with its last member.
    toast('Saved. Restart the app before this takes effect.')
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

document.getElementById('set-auto-lock').addEventListener('change', async (evt) => {
  const minutes = Number(evt.target.value)
  try {
    await request('wallet.setAutoLock', { minutes })
    toast(minutes === 0 ? 'The wallet will not lock itself' : `Locking after ${minutes} min`)
  } catch (err) {
    toast(err.message, 'error')
    void openSettings()
  }
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
        // `keysDir` and `containerName` are shown above and deliberately not
        // sent. Both are arguments to Docker — a bind mount and the subject of
        // `rm -f` — so the worker refuses them from a window, and sending them
        // anyway would fail the whole save.
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

// --- Inference ---------------------------------------------------------------

/**
 * The two things somebody sets before asking a model anything: the standing
 * instructions to put in front of a prompt, and the ceiling on what asking is
 * allowed to cost.
 *
 * Both are sealed under the unlocked account and never leave this machine, so
 * both read back empty while the wallet is locked — which is why the empty
 * state below says which of those two it is looking at instead of assuming
 * nothing has been saved.
 *
 * Neither handler is guaranteed to be there. The worker is the other half of a
 * contract, it ships on its own schedule, and one that predates these answers
 * `unknown request`. So each half of this page fails alone and says why, rather
 * than leaving a heading over an empty box.
 */

const inference = {
  templateStatus: document.getElementById('template-status'),
  templateList: document.getElementById('template-list'),
  templateEmpty: document.getElementById('template-empty'),
  templateForm: document.getElementById('template-form'),
  templateName: document.getElementById('template-name'),
  templateBody: document.getElementById('template-body'),
  templateCaps: document.getElementById('template-caps'),
  templateError: document.getElementById('template-error'),
  templateSave: document.getElementById('template-save'),
  templateCancel: document.getElementById('template-cancel'),
  limitsStatus: document.getElementById('limits-status'),
  limitsForm: document.getElementById('limits-form'),
  limitsError: document.getElementById('limits-error'),
  limitsSave: document.getElementById('limits-save'),
  limitsFacts: document.getElementById('limits-facts')
}

/**
 * Whether anything sealed can be read at all, which is what decides what an
 * empty page means here.
 *
 * Asked of the worker as this page loads rather than taken from whatever the
 * wallet panel last cached, because the difference between "you have set none
 * of these" and "this machine cannot tell" is the entire value of saying
 * either, and a confident wrong answer is worse than no answer. Read as false
 * if the question itself fails: an unprompted claim that the wallet is locked
 * would be the same confident wrong answer in the other direction.
 */
let locked = false

// --- Templates ---------------------------------------------------------------

/**
 * How long a template may be, and how many there may be.
 *
 * A name is short because it is read in a list; a body is capped at the length
 * of the longest message a room will carry, which is the only figure in this
 * application with any claim to being the size of a piece of writing. None of
 * these three is enforcement — the worker keeps its own limits and its refusal
 * is the one that counts. They are here so that reaching a cap is a sentence
 * before the round trip rather than an error after it, and so that nothing is
 * ever quietly cut short.
 */
const NAME_LENGTH = 64
const BODY_LENGTH = 4096
const TEMPLATES_HELD = 32

let templates = []

/** Which template the form is editing, or null while it is adding one. */
let editing = null

/**
 * The list as this page will draw it.
 *
 * Normalised on the way in rather than trusted. These come from a handler this
 * sandboxed renderer cannot import and cannot check against, and a single
 * missing field would put the word "undefined" in the middle of somebody's own
 * writing.
 */
function shapeTemplates(reply) {
  const held = Array.isArray(reply?.templates) ? reply.templates : []

  return held
    .filter((template) => template && typeof template.id === 'string')
    .map((template) => ({
      id: template.id,
      name: typeof template.name === 'string' ? template.name : '',
      body: typeof template.body === 'string' ? template.body : ''
    }))
}

function renderTemplates() {
  inference.templateList.replaceChildren()

  for (const template of templates) {
    const item = document.createElement('li')
    item.className = 'template'

    const main = document.createElement('div')
    main.className = 'template-main'

    // Built as nodes and filled through textContent, never as markup. A name is
    // text somebody typed into a box, and this list is the one place it is
    // drawn: assembled as a string, a template called `<img src=x onerror=…>`
    // would be a way to run script inside a window that can reach the main
    // process.
    const name = document.createElement('span')
    name.className = 'template-name'
    name.textContent = template.name

    const body = document.createElement('p')
    body.className = 'template-body'
    body.textContent = template.body

    main.append(name, body)

    const actions = document.createElement('div')
    actions.className = 'template-actions'

    const edit = document.createElement('button')
    edit.className = 'button button-sm'
    edit.type = 'button'
    edit.textContent = 'Edit'
    edit.addEventListener('click', () => startEditing(template))

    const remove = document.createElement('button')
    remove.className = 'button button-sm'
    remove.type = 'button'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => void removeTemplate(template))

    actions.append(edit, remove)
    item.append(main, actions)
    inference.templateList.append(item)
  }

  inference.templateEmpty.hidden = templates.length > 0
  inference.templateEmpty.textContent = locked
    ? 'Unlock your wallet to see your templates. They are sealed under it, so a locked machine cannot tell whether there are any.'
    : 'No templates yet.'

  inference.templateCaps.textContent =
    `${templates.length} of ${TEMPLATES_HELD} kept. ` +
    `A name may run to ${NAME_LENGTH} characters and the text to ${BODY_LENGTH}.`
}

function startEditing(template) {
  editing = template.id
  inference.templateName.value = template.name
  inference.templateBody.value = template.body
  inference.templateError.hidden = true
  inference.templateSave.textContent = 'Save changes'
  inference.templateCancel.hidden = false
  inference.templateName.focus()
}

function stopEditing() {
  editing = null
  inference.templateName.value = ''
  inference.templateBody.value = ''
  inference.templateError.hidden = true
  inference.templateSave.textContent = 'Add template'
  inference.templateCancel.hidden = true
}

/**
 * Why this template cannot be saved, or null.
 *
 * Every cap is reported as the number it is and the number it was given, so
 * somebody who has pasted a long instruction can see how much of it has to go.
 * Being told "too long" and left to guess is the reason people delete the lot
 * and start again.
 */
function refuseTemplate(name, body) {
  if (name === '') return 'Give the template a name.'
  if (name.length > NAME_LENGTH) {
    return `A template name may not exceed ${NAME_LENGTH} characters, and this one is ${name.length}.`
  }
  if (body.trim() === '') return 'A template with no text in it would do nothing.'
  if (body.length > BODY_LENGTH) {
    return `A template may not exceed ${BODY_LENGTH} characters, and this one is ${body.length}.`
  }
  if (editing === null && templates.length >= TEMPLATES_HELD) {
    return `${TEMPLATES_HELD} templates are kept at once; remove one before adding another.`
  }
  return null
}

async function refreshTemplates() {
  try {
    templates = shapeTemplates(await request('local.templates'))
    inference.templateStatus.hidden = true
    inference.templateList.hidden = false
    inference.templateForm.hidden = false
    renderTemplates()
  } catch (err) {
    // The worker's own words, verbatim. A message invented here would hide
    // whether this is a build that has never had the handler, a store that
    // would not open or something nobody has seen yet.
    templates = []
    inference.templateList.replaceChildren()
    inference.templateList.hidden = true
    inference.templateEmpty.hidden = true
    inference.templateForm.hidden = true
    inference.templateStatus.textContent = `Templates are not available: ${err.message}`
    inference.templateStatus.hidden = false
  }
}

async function removeTemplate(template) {
  try {
    const reply = await request('local.removeTemplate', { id: template.id })
    templates = shapeTemplates(reply)

    // Editing the one that has just gone would put it straight back.
    if (editing === template.id) stopEditing()
    renderTemplates()

    // A sealed store with no key writes nothing and reads back empty, which is
    // every request made while the wallet is locked. The list on screen is now
    // that empty answer rather than anything lost.
    if (reply.written === false) toast('Not removed; the list shows what is stored', 'error')
    else toast('Removed')
  } catch (err) {
    toast(err.message, 'error')
  }
}

inference.templateForm.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = inference.templateError
  error.hidden = true

  // A name has its runs of whitespace collapsed and its ends trimmed, because
  // it is drawn as one line in a list beside two buttons and "  Reviewer   of
  // things " is the same template as "Reviewer of things", pasted carelessly.
  // The text below keeps every space and line break it was given: the shape of
  // an instruction is part of the instruction.
  const name = inference.templateName.value.replace(/\s+/g, ' ').trim()
  const body = inference.templateBody.value

  const refusal = refuseTemplate(name, body)
  if (refusal !== null) {
    error.textContent = refusal
    error.hidden = false
    return
  }

  inference.templateSave.disabled = true

  try {
    const reply = await request('local.saveTemplate', {
      // Omitted rather than sent as null, because absent is how the handler is
      // told to make a new one.
      ...(editing === null ? {} : { id: editing }),
      name,
      body
    })

    templates = shapeTemplates(reply)
    stopEditing()
    renderTemplates()

    if (reply.written === false) toast('Not saved; the list shows what is stored', 'error')
    else toast('Saved')
  } catch (err) {
    // The form keeps what was typed and stays in whichever mode it was in, so
    // a refusal costs a correction rather than the whole template.
    error.textContent = err.message
    error.hidden = false
  } finally {
    inference.templateSave.disabled = false
  }
})

inference.templateCancel.addEventListener('click', stopEditing)

// --- Spending limits ---------------------------------------------------------

/**
 * LCAI as somebody typed it, to wei, without touching a float on the way.
 *
 * There are 10^18 wei in one LCAI and a double holds about sixteen digits, so
 * the multiplication is wrong before it starts: `1.1 * 1e18` is 128 wei above
 * 1100000000000000000, and `0.07 * 1e18` is eight above. Neither is visible and
 * both are a limit set to one amount and stored as another. The digits are
 * moved by hand instead — everything left of the point, everything right of it
 * padded out to eighteen places, the two read as a single integer.
 */
function toWei(amount) {
  const text = amount.trim()
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    throw new Error('Enter an amount in LCAI, like 0.02, or leave it empty for no limit')
  }

  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > 18) throw new Error('LCAI has 18 decimal places, no more')
  return BigInt(whole + fraction.padEnd(18, '0'))
}

/**
 * An amount as the worker sends one: a decimal string, because a bigint does
 * not survive JSON and a number would lose the bottom of it.
 *
 * Anything else is read as no limit rather than coerced. `BigInt` throws on a
 * malformed string, and left unchecked it would throw here, part-way through
 * drawing, with nothing on the page able to say what happened.
 */
function decimal(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null
}

/**
 * The two caps, each with the text it was last filled with and the exact wei
 * behind that text. See `amountFrom` for why both are kept.
 */
const caps = {
  perJob: {
    key: 'perJob',
    label: 'per-job',
    input: document.getElementById('limit-per-job'),
    hint: document.getElementById('limit-per-job-wei'),
    shown: '',
    wei: null
  },
  daily: {
    key: 'daily',
    label: 'daily',
    input: document.getElementById('limit-daily'),
    hint: document.getElementById('limit-daily-wei'),
    shown: '',
    wei: null
  }
}

/**
 * What a field means, given that it may not have been touched.
 *
 * `formatLcai` stops at six decimal places, so a limit set finer than that is
 * printed back shorter than it was set, and parsing what was printed would
 * quietly lower it — somebody who opened this page and saved something else
 * would have their cap cut by the act of looking at it. A field still holding
 * exactly the text it was filled with therefore means the amount already
 * stored, whatever its precision. Only text somebody actually changed is
 * parsed.
 */
function amountFrom(cap) {
  const text = cap.input.value.trim()
  if (text === cap.shown) return cap.wei
  return text === '' ? null : toWei(text).toString()
}

/**
 * What this field will send, under the field.
 *
 * Every other field in this panel shows both what is stored and what it
 * resolves to, and for money the resolution is the half worth checking: an
 * amount typed in LCAI is submitted as an integer number of wei, and this is
 * the integer.
 */
function describe(cap) {
  try {
    const wei = amountFrom(cap)
    cap.hint.textContent = wei === null ? 'no limit' : `${wei} wei`
  } catch {
    // Not a number yet. The refusal belongs on the submit, where it is a
    // sentence, rather than here where it would flicker as somebody types "0.".
    cap.hint.textContent = '—'
  }
}

function showLimits(reply) {
  for (const cap of Object.values(caps)) {
    cap.wei = decimal(reply?.[cap.key])
    cap.shown = cap.wei === null ? '' : formatLcai(cap.wei)
    cap.input.value = cap.shown
    describe(cap)
  }

  const spent = decimal(reply?.spentToday) ?? '0'
  const rows = [['Spent today', `${formatLcai(spent)} LCAI`]]

  // What is left is arithmetic somebody would otherwise do in their head
  // against an eighteen-digit number, and it is the figure that decides whether
  // the next question goes through. Floored at nothing, because a limit lowered
  // after the spending happened would otherwise report a negative allowance.
  if (caps.daily.wei !== null) {
    const left = BigInt(caps.daily.wei) - BigInt(spent)
    rows.push(['Left today', `${formatLcai(left > 0n ? left : 0n)} LCAI`])
  }

  facts(inference.limitsFacts, rows)
}

async function refreshLimits() {
  try {
    showLimits(await request('ai.limits'))
    inference.limitsForm.hidden = false
    inference.limitsFacts.hidden = false

    // A locked wallet reads back no limits and nothing spent, which is exactly
    // what somebody who has never set one sees. Saying which of the two this is
    // beats a page reporting a confident zero it cannot know.
    inference.limitsStatus.textContent = locked
      ? 'Your wallet is locked. These are sealed under it, so nothing here is being read or stored.'
      : ''
    inference.limitsStatus.hidden = !locked
  } catch (err) {
    inference.limitsForm.hidden = true
    inference.limitsFacts.hidden = true
    inference.limitsStatus.textContent = `Spending limits are not available: ${err.message}`
    inference.limitsStatus.hidden = false
  }
}

for (const cap of Object.values(caps)) {
  cap.input.addEventListener('input', () => describe(cap))
}

inference.limitsForm.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = inference.limitsError
  error.hidden = true

  let asked
  try {
    asked = { perJob: amountFrom(caps.perJob), daily: amountFrom(caps.daily) }
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
    return
  }

  // Zero is a limit, and the limit it is refuses everything. Somebody who wants
  // no limit clears the field; somebody who typed 0 has almost certainly meant
  // that and would spend the next hour on an application that has quietly
  // stopped working.
  for (const cap of Object.values(caps)) {
    if (asked[cap.key] === '0') {
      error.textContent = `A ${cap.label} limit of zero would refuse every job. Leave the field empty for no limit.`
      error.hidden = false
      return
    }
  }

  inference.limitsSave.disabled = true

  try {
    const reply = await request('ai.setLimits', asked)
    showLimits(reply)

    // The reply is the stored state rather than an echo, so comparing it with
    // what was asked for is how this finds out whether anything was written —
    // a locked wallet seals nothing and says so only by giving the old values
    // back. The fields have already reverted to the truth; this says so out
    // loud, because a form that snaps back without comment reads as a glitch.
    const kept = asked.perJob === caps.perJob.wei && asked.daily === caps.daily.wei
    if (kept) toast('Limits saved')
    else toast('Not stored; the fields show what is saved', 'error')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    inference.limitsSave.disabled = false
  }
})

/**
 * Both halves, each failing on its own.
 *
 * Nothing here may reject: this is called from `openSettings` without being
 * awaited, and an unhandled rejection there is an error in the console and a
 * page that stops half-drawn.
 */
async function refreshInference() {
  locked = await request('wallet.status')
    .then((status) => status.unlocked !== true)
    .catch(() => false)

  await Promise.all([refreshTemplates(), refreshLimits()])
}
