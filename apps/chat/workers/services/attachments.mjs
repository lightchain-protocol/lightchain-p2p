/**
 * Files that ride alongside a room's messages, one store per room.
 *
 * Opening one attaches a replication listener, and leaving a room has to take it
 * off again — the pair belongs together, which is the argument for this file.
 * `rooms` is a getter for the same reason it is in the registry: the RoomHost
 * does not exist yet when this is built.
 */

import { Attachments } from '@lcai-p2p/room'

export function createAttachments({ chatStore, swarm, rooms }) {
  /**
   * Files that ride alongside a room's messages, one store per room.
   *
   * Opened lazily and kept, because a room's blob core has to exist before an
   * attachment can be put in it and has to stay open for anyone to fetch one
   * back. Sealed with the room's own encryption key, so the blind peers that hold
   * a room for us can no more read its files than its conversation.
   */
  const attachments = new Map()

  async function attachmentsFor(key) {
    const held = attachments.get(key)
    if (held) return held?.store ?? held

    const { encryptionKey } = rooms().credentials(key)
    const store = await Attachments.open({
      store: chatStore,
      namespace: `attachments:${key}`,
      encryptionKey
    })

    // Kept so leaving can take it off again. Adding a listener per room and never
    // removing one means a long session that attaches in many rooms replicates
    // every store it has ever opened on every new connection, including for rooms
    // this machine has left.
    const replicate = (socket) => store.replicate(socket)
    swarm.on('connection', replicate)
    for (const socket of swarm.connections) store.replicate(socket)

    attachments.set(key, { store, replicate })
    return store
  }

  /**
   * Lets go of a room's attachments.
   *
   * Leaving used to close the room and leave this behind: the store stayed open,
   * its connection listener stayed attached, and both outlived any reason to
   * exist. Nothing failed visibly, which is why it survived.
   */
  async function forgetAttachments(key) {
    const held = attachments.get(key)
    if (!held) return

    attachments.delete(key)
    swarm.off('connection', held.replicate)
    await held.store.close?.().catch(() => {})
  }

  return { open: attachmentsFor, forget: forgetAttachments }
}
