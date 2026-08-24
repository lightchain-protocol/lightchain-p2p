/**
 * A directory of sealed documents.
 *
 * Used by both {@link SealedStore} instances the worker keeps — local state and
 * worker secrets — so it belongs to neither of them.
 */

import path from 'bare-path'
import fs from 'bare-fs'

/**
 * A directory of sealed documents, for {@link SealedStore} to write into.
 *
 * Names arrive already scoped and validated by the store, which refuses
 * anything that is not a plain word — so nothing reaching here can walk out of
 * this directory. Mode 0600 for the same reason the vault has it: these are
 * ciphertext, but on a shared machine there is no reason for anybody else to
 * hold a copy to work on.
 */
export function fileByteStore(dir) {
  const at = (name) => path.join(dir, `${name}.sealed`)

  return {
    read(name) {
      try {
        return fs.readFileSync(at(name))
      } catch {
        // Absent is the ordinary state of a first run, not a failure.
        return null
      }
    },
    write(name, bytes) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(at(name), Buffer.from(bytes), { mode: 0o600 })
    },
    delete(name) {
      try {
        fs.unlinkSync(at(name))
      } catch {
        // Already gone, which is what was wanted.
      }
    },
    list() {
      try {
        return fs
          .readdirSync(dir)
          .filter((file) => file.endsWith('.sealed'))
          .map((file) => file.slice(0, -'.sealed'.length))
      } catch {
        return []
      }
    }
  }
}
