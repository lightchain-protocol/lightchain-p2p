/**
 * The sealed list of which rooms to reopen, and as whom.
 *
 * The registry, its two one-time migrations and the key it is sealed under were
 * spread through the boot sequence with the host budget and the vault path
 * interleaved between them. They are one subject: this file is the only thing
 * that knows a room list is a file, that the file is per account, and that
 * unlocking it is what makes rooms openable at all.
 *
 * `rooms` arrives as a getter because the {@link RoomHost} is built from this
 * registry — it cannot be handed in at construction without a cycle.
 */

import path from 'bare-path'
import fs from 'bare-fs'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { deriveKey, openJson, sealJson } from '@lcai-p2p/wallet'

/**
 * Which rooms to reopen, and as whom.
 *
 * The namespace matters as much as the key: it decides which writer core a room
 * comes back on, so losing this file costs the write access each room granted
 * this peer, not merely the list.
 *
 * **Every record carries its room's encryption key**, so this file is the one
 * thing that reads every room. It used to sit in the clear, on the reasoning
 * that a room has to reopen without anyone typing a password — which stopped
 * being true when the wallet became mandatory at first run. It is now sealed
 * under a key derived from that wallet, so reading it costs the same password
 * the wallet does, and file permissions are no longer the boundary.
 *
 * The consequence is deliberate: rooms do not open until the wallet is
 * unlocked. Nothing else in the app does either.
 */
const ROOM_KEY_PURPOSE = 'room registry'

function usableRecords(parsed) {
  if (!Array.isArray(parsed)) return []

  const usable = parsed.filter(
    (e) =>
      e &&
      typeof e.key === 'string' &&
      typeof e.namespace === 'string' &&
      typeof e.encryptionKey === 'string'
  )

  // A record with no encryption key cannot open its room at all. Say so, rather
  // than letting the room disappear from the list without comment.
  const dropped = parsed.length - usable.length
  if (dropped > 0) console.error(`${dropped} room(s) have no encryption key and cannot open`)

  return usable
}

export function createRegistry({ chatDir, wallet, send, rooms }) {
  // Not `.json`: it is ciphertext, and a name promising otherwise invites
  // somebody to open it in an editor and conclude the file is corrupt. Kept only
  // to be migrated: room lists are now one file per account, see registryPathFor.
  const unscopedRegistryFile = path.join(chatDir, 'rooms.sealed')
  const legacyRegistryFile = path.join(chatDir, 'rooms.json')

  let registryKey = null
  let registryFor = null

  /**
   * Where this account's room list lives.
   *
   * One file per identity, named by a hash of the derived key rather than by the
   * address, so the filename says nothing about who uses this machine.
   *
   * The scoping is not tidiness. A wallet can now unlock at any account index,
   * and each index derives different keys — so the moment a second account saved
   * anything, a single shared file would be resealed under a key the first
   * account cannot produce. That does not merely lose a list. Each record holds
   * the **namespace** a room reopens on, which is what decides which writer core
   * it comes back as, so losing it costs the write access every one of those
   * rooms granted this peer. No invite brings that back; somebody has to be added
   * again, by somebody who is still a writer.
   */
  function registryPathFor(key) {
    const scope = b4a.toString(crypto.hash(Buffer.from(key)), 'hex').slice(0, 16)
    return path.join(chatDir, `rooms.${scope}.sealed`)
  }

  const registry = {
    read() {
      if (!registryKey) return []

      try {
        return usableRecords(openJson(registryKey, fs.readFileSync(registryFor)))
      } catch {
        // Absent on first run, and a damaged file should not stop the app
        // starting: it costs the room list, and the rooms are still on disk.
        return []
      }
    },
    write(records) {
      if (!registryKey) return

      try {
        fs.mkdirSync(chatDir, { recursive: true })
        fs.writeFileSync(registryFor, Buffer.from(sealJson(registryKey, records)), { mode: 0o600 })
      } catch (err) {
        console.error('could not record the room list:', err.message)
      }
    }
  }

  /**
   * Unlocks the registry, bringing across anything left in the clear.
   *
   * Two migrations run once each and then never again. The oldest installations
   * have a plaintext `rooms.json`; the ones after that have a single sealed
   * `rooms.sealed` written before accounts could be switched. Both are read,
   * rewritten into this account's own file and deleted. Skipping either would
   * silently orphan every room somebody already had — still on disk, and nothing
   * left that knows how to open them.
   */
  async function unlockRegistry() {
    if (registryKey) return

    registryKey = deriveKey(wallet.account(), ROOM_KEY_PURPOSE)
    registryFor = registryPathFor(registryKey)

    let carried = []
    let carriedFrom = null

    try {
      carried = usableRecords(JSON.parse(fs.readFileSync(legacyRegistryFile, 'utf8')))
      if (carried.length > 0) carriedFrom = legacyRegistryFile
    } catch {
      // Nothing to bring across, which is the normal case.
    }

    // The unscoped sealed file, from before one wallet could hold several
    // accounts. It only opens under the key that wrote it, so whichever account
    // that was adopts it and the rest correctly see nothing.
    if (carried.length === 0 && !fs.existsSync(registryFor)) {
      try {
        carried = usableRecords(openJson(registryKey, fs.readFileSync(unscopedRegistryFile)))
        if (carried.length > 0) carriedFrom = unscopedRegistryFile
      } catch {
        // Either absent, or sealed under a different account's key.
      }
    }

    if (carried.length > 0) {
      registry.write(carried)
      console.log(`moved ${carried.length} room(s) into this account's own list`)
    }

    // The plaintext one goes: it is a secret sitting in the open. The unscoped
    // sealed one stays, because another account on this machine may still be the
    // one able to read it, and deleting it would take their rooms with it.
    if (carriedFrom === legacyRegistryFile) {
      try {
        fs.unlinkSync(legacyRegistryFile)
      } catch {
        // Already gone.
      }
    }

    for (const room of await rooms().reload(registry.read())) send({ t: 'room', room })
  }

  /** Locking closes the registry too: its key is the wallet's. */
  function lockRegistry() {
    registryKey = null
    registryFor = null
  }

  return {
    read: () => registry.read(),
    write: (records) => registry.write(records),
    unlock: unlockRegistry,
    lock: lockRegistry,
    // RoomHost takes the record store itself, not the service around it.
    records: registry
  }
}
