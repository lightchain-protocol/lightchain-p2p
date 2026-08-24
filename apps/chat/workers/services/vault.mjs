/**
 * Where the wallet's vault lives on this machine, and how it is read.
 *
 * The {@link Wallet} takes a store rather than a path, so this is the whole of
 * the worker's opinion about the file: where it sits, that it is `0600`, and
 * that "absent" means `ENOENT` and nothing else.
 */

import path from 'bare-path'
import fs from 'bare-fs'

export function createVault({ chatDir }) {
  /**
   * The wallet's vault, next to the chat storage.
   *
   * Encrypted, so unlike `rooms.json` this is not a plaintext secret — but it
   * holds the recovery phrase for every account the user will ever derive, so it
   * is written `0600` where that means anything. The phrase written on paper is
   * the actual backup; this file is convenience.
   */
  const vaultFile = path.join(chatDir, 'vault.json')

  /**
   * When this vault was last written, for the screen that asks for its password.
   *
   * The address cannot be shown on a locked screen — it is inside the ciphertext,
   * and recording it outside would be a privacy decision rather than a fix. The
   * file's own timestamp costs nothing and answers the question that actually
   * traps people: *which* wallet is this. A vault the operating system deleted
   * and an onboarding flow silently replaced is indistinguishable from the
   * original one until the password fails, and then it reads as the application
   * refusing a password that is plainly correct — because for the wallet somebody
   * remembers, it is.
   *
   * A modification time, honestly labelled as one. Copying a vault between
   * machines moves it, which is why the screen says "last written" rather than
   * claiming a creation date it cannot know.
   */
  function vaultWrittenAt() {
    try {
      return fs.statSync(vaultFile).mtimeMs
    } catch {
      return null
    }
  }

  const vaultStore = {
    /**
     * The vault, or `null` only when there genuinely is not one.
     *
     * This used to catch everything and answer `null`, so a corrupt byte, a
     * half-written file or a permissions problem all reported "this machine has
     * no wallet". The application believed it: onboarding offered to make one,
     * and the gate that demands a typed REPLACE is keyed on a wallet being
     * present, so it did not fire — the ciphertext was overwritten and the phrase
     * it held was the only way back to that money.
     *
     * Absent is `ENOENT` and nothing else. Anything else is a file that is there
     * and cannot be read, which is a thing to say out loud.
     */
    read() {
      let raw
      try {
        raw = fs.readFileSync(vaultFile, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw new Error(`the wallet file could not be read: ${err.message}`, { cause: err })
      }

      try {
        return JSON.parse(raw)
      } catch (err) {
        throw new Error(`the wallet file is not readable JSON: ${err.message}`, { cause: err })
      }
    },
    write(vault) {
      fs.mkdirSync(chatDir, { recursive: true })
      fs.writeFileSync(vaultFile, JSON.stringify(vault, null, 2), { mode: 0o600 })
    },
    clear() {
      try {
        fs.unlinkSync(vaultFile)
      } catch {
        // Already gone is the outcome we wanted.
      }
    }
  }

  return { store: vaultStore, writtenAt: vaultWrittenAt }
}
