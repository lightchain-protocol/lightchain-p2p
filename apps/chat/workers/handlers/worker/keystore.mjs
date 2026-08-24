/**
 * The keystore file: writing one, and getting a password that opens it.
 *
 * Nothing here goes near Docker. The key is encrypted in this process and the
 * password never reaches a command line.
 */

import path from 'bare-path'
import fs from 'bare-fs'

import { KEYSTORE_DIR, keystoreFileName, selectKeystore } from '@lcai-p2p/worker'
import { encrypt } from '@lcai-p2p/wallet'

import { checkKeystorePassword } from './support.mjs'

export function createKeystore(ctx) {
  const { adoptWorkerPassword } = ctx

  /**
   * Writes a private key into a keystore inside the worker's data directory.
   *
   * The same path `lcai-supervisor import-key` takes: the key is encrypted here,
   * in this process, into a Keystore V3 file that go-ethereum reads, and Docker
   * is never told it — the image's own `import-key` wants the key as a
   * command-line flag, which would put it in the host's process table. The key
   * and password arrive in the IPC body, never on a command line, and nothing
   * here logs either.
   *
   * Refuses when a keystore already exists: a second file makes
   * `selectKeystore` ambiguous, and a worker that registers as the wrong address
   * looks healthy while earning to somebody else. Replacing a key is a
   * deliberate, manual act — delete the old file first.
   *
   * Returns the address, lowercase hex without a 0x prefix.
   */
  function writeKeystore(config, privateKey) {
    const dir = path.join(config.keysDir, KEYSTORE_DIR)

    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      // A missing directory is the ordinary first-run state.
    }

    try {
      const existing = selectKeystore(names)
      throw new Error(
        `a worker key already exists (0x${existing.address}). Delete its file from the data directory first if you mean to replace it.`
      )
    } catch (err) {
      // selectKeystore's "none found" is the way through; anything it found —
      // one key or several — is a reason to stop, and the error above says so.
      if (!/no keystore file found/.test(err.message)) throw err
    }

    const keystore = encrypt(privateKey, config.keystorePassword)
    fs.mkdirSync(dir, { recursive: true })
    // 0600 because the password is the only thing between this file and the
    // account, on platforms that honour the mode.
    fs.writeFileSync(path.join(dir, keystoreFileName(keystore.address)), JSON.stringify(keystore), {
      mode: 0o600
    })
    return keystore.address
  }

  /**
   * The password a key was just sealed with becomes the worker's configured
   * password, so Register and Start can open the keystore without asking again.
   *
   * Two things happen before it is adopted. The keystore is opened with it
   * first, locally — a password that does not decrypt the file fails here, at
   * setup, rather than inside the container at `docker run`. Then it is sealed
   * under the wallet account, not written to settings.json: that file was the
   * one place the password sat in the clear, readable by anything that could
   * write settings from the window. Sealing needs an unlocked wallet, and
   * `adoptWorkerPassword` refuses without one.
   */
  function adoptPassword(config, password) {
    const check = checkKeystorePassword(config, password)
    if (!check.ok) throw new Error(`not adopting the password: ${check.problem}`)
    adoptWorkerPassword(password)
  }

  function passwordFrom(req) {
    const password = typeof req.password === 'string' ? req.password : ''
    if (password.length < 8) {
      throw new Error('the keystore password must be at least 8 characters')
    }
    return password
  }

  return { writeKeystore, adoptPassword, passwordFrom }
}
