import fs from 'bare-fs'
import path from 'bare-path'

/**
 * Where the keystore password is kept, and how it is read and written.
 *
 * Apart from `worker.mjs` because that module reaches for `bare-os` at import
 * time, which has no Node build and so cannot be loaded by the test runner.
 * Only `bare-fs` and `bare-path` are used here, and both are aliased to their
 * Node equivalents under vitest.
 */

/** The protected file holding the keystore password. */
export function passwordPath(keysDir) {
  return path.join(keysDir, 'keystore-password')
}

/**
 * Reads the keystore password from its file, or null if there is not one.
 *
 * A trailing newline is stripped because an operator writing this with a text
 * editor gets one for free, and a password differing from the one they typed by
 * an invisible byte fails at registration with nothing to suggest why.
 */
export function readPasswordFile(keysDir) {
  try {
    const text = fs.readFileSync(passwordPath(keysDir), 'utf8').replace(/\r?\n$/, '')
    return text || null
  } catch {
    return null
  }
}

/**
 * Writes the password where only the operator can read it.
 *
 * The worker restarts unattended, so whatever holds this has to be readable by
 * a machine with nobody at the keyboard. That rules out protecting it with a
 * passphrase and makes this a permission boundary rather than a cryptographic
 * one — see the README for what that does and does not cover.
 */
export function writePasswordFile(keysDir, password) {
  fs.mkdirSync(keysDir, { recursive: true })
  fs.writeFileSync(passwordPath(keysDir), password, { mode: 0o600 })
  // `mode` on write is masked by umask and ignored entirely for a file that
  // already exists, so neither case is actually covered without this.
  fs.chmodSync(passwordPath(keysDir), 0o600)
}
