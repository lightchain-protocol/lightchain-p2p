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
 * Opens the wallet, making one if the instance has none.
 *
 * Throws with something worth reading when the wallet was made by something
 * else, because the useful next step is to clear the storage directory rather
 * than to guess at a password.
 */
export async function unlockForHarness(ask) {
  const status = await ask('wallet.status')

  if (!status?.exists) {
    const made = await ask('wallet.create', { password: HARNESS_PASSWORD })
    if (made?.error) throw new Error(`could not create a wallet: ${made.error}`)
    return ask('wallet.status')
  }

  if (!status.unlocked) {
    const opened = await ask('wallet.unlock', { password: HARNESS_PASSWORD })
    if (opened?.error) {
      throw new Error(
        `this instance has a wallet the harnesses did not create (${opened.error}). Stop it, delete its storage directory, and start it again.`
      )
    }
  }

  return ask('wallet.status')
}
