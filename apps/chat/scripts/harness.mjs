/**
 * What the harnesses share, so they can be run one after another.
 *
 * Every script here needs an unlocked wallet, and a storage directory holds
 * exactly one. When each script invented its own password the first to run
 * created the wallet and the rest silently failed to open it — then wrote
 * everything unsigned, at which point the fail-closed rules correctly refused
 * every edit and withdrawal and the output looked exactly like a product bug.
 * That cost an hour of chasing on four separate occasions, so the password
 * lives here and nowhere else.
 */
export const HARNESS_PASSWORD = 'a password these harnesses agree on'

/**
 * A request sent the way the renderer sends one, as source to inject.
 *
 * The harnesses talk to the worker over the same pipe the app does, so they
 * have to frame messages the same way: a newline ends a request, and a chunk
 * may hold several replies or half of one. Reading a chunk as exactly one
 * message is what the worker's own framing bug looked like from here, and a
 * harness that gets this wrong reports a hang the app does not have — or, worse,
 * misses one it does.
 *
 * This lives here as a string because it is evaluated inside the window.
 */
export const ASK = `(t, fields) => new Promise((resolve) => {
  const rid = 'v-' + Math.random().toString(36).slice(2)
  const decoder = new TextDecoder()
  let held = ''
  const timer = setTimeout(() => { off(); resolve({ error: 'no answer in 20s' }) }, 20000)
  const off = window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    held += decoder.decode(data, { stream: true })
    const lines = held.split('\\n')
    held = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.rid !== rid) continue
      clearTimeout(timer)
      off()
      resolve(msg.t === 'error' ? { error: msg.message } : (msg.value ?? null))
    }
  })
  window.bridge.writeWorkerIPC('/workers/main.mjs', JSON.stringify({ rid, t, ...fields }) + '\\n')
})`

/**
 * Every password a harness is known to leave behind, newest attempt first.
 *
 * One of these scripts exists to prove the Settings form really changes a
 * password, and another proves a wallet can be restored under a new one. Both
 * do their job and both leave the instance holding a password the next script
 * would not guess, so running two suites against one instance failed on the
 * second — not because anything was broken, but because the first had succeeded.
 *
 * Listing them is honest about what these scripts collectively own. The
 * alternative, making each suite tear its wallet down, would delete the very
 * state the next one wants to find.
 */
const HARNESS_PASSWORDS = [
  HARNESS_PASSWORD,
  'a different password entirely',
  'a different password again'
]

/**
 * Opens the wallet, making one if the instance has none.
 *
 * Throws with something worth reading when none of the known passwords fit,
 * because the useful next step is to clear the storage directory rather than to
 * keep guessing.
 */
export async function unlockForHarness(ask) {
  const status = await ask('wallet.status')

  if (!status?.exists) {
    const made = await ask('wallet.create', { password: HARNESS_PASSWORD })
    if (made?.error) throw new Error(`could not create a wallet: ${made.error}`)
    return ask('wallet.status')
  }

  if (!status.unlocked) {
    let last = null
    for (const password of HARNESS_PASSWORDS) {
      const opened = await ask('wallet.unlock', { password })
      if (!opened?.error) return ask('wallet.status')
      last = opened.error
    }

    throw new Error(
      `this instance has a wallet no harness password opens (${last}). Stop it, delete its storage directory, and start it again.`
    )
  }

  return ask('wallet.status')
}
