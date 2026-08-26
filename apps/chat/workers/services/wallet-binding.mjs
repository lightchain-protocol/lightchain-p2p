/**
 * Ties the wallet to the rooms, in both directions.
 *
 * One function, but it is the join between four subjects — the wallet, the room
 * host, the sealed registry and the worker's secrets — and it is what makes
 * unlocking mean anything. Sitting loose in the boot sequence, it read as one
 * more step rather than as the hinge it is.
 */

import { keccak256, toHex } from '@lcai-p2p/chain'

export function createWalletBinding({ wallet, rooms, registry, secrets }) {
  /**
   * Ties the wallet to the rooms, in both directions.
   *
   * Unlocking makes everything this peer writes provably theirs; locking stops
   * it. Neither touches what is already written, which cannot be changed and
   * should not appear to have been.
   */
  function useWalletInRooms() {
    const { unlocked } = wallet.status()
    if (!unlocked) {
      rooms().useIdentity(null)
      registry.lock()
      return
    }

    // The registry is sealed under this wallet, so unlocking it is what makes the
    // rooms openable at all — not merely signed.
    void registry
      .unlock()
      .catch((err) => console.error('could not open the room list:', err.message))

    // Same moment, same reason: a plaintext workerPassword left in settings.json
    // by an older version can only be sealed once the wallet's key exists.
    try {
      secrets.migrate()
    } catch (err) {
      console.error('could not seal the worker keystore password:', err.message)
    }

    const account = wallet.account()
    rooms().useIdentity({
      address: account.address,
      sign: (preimage) => account.signMessage(preimage),
      hashText: (text) => toHex(keccak256(new TextEncoder().encode(text)))
    })
  }

  return useWalletInRooms
}
