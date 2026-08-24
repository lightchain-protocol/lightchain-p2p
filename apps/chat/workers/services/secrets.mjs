/**
 * The two sealed stores, and the one password that has to migrate into one.
 *
 * Both are sealed under the wallet account and both answer nothing while it is
 * locked. They were declared sixty lines apart in `main.mjs` with the guard and
 * the context object between them.
 */

import path from 'bare-path'
import process from 'bare-process'
import { SealedStore } from '@lcai-p2p/wallet'
import {
  WORKER_PASSWORD_DOC,
  migrateWorkerPassword,
  readWorkerPassword
} from '../handlers/worker.mjs'
import { fileByteStore } from './file-store.mjs'

export function createSecrets({ chatDir, wallet, settings }) {
  /**
   * Everything one person keeps to themselves.
   *
   * Unread marks, drafts, muted rooms, blocked participants, notification
   * preferences, an address book and a ledger of this wallet's own transactions.
   * None of it is anybody else's business and none of it is replicated: it is
   * sealed under the account, in files beside the room list, and a peer never
   * learns any of it exists.
   */
  const localState = new SealedStore(fileByteStore(path.join(chatDir, 'local')), {
    purpose: 'local state',
    // Asked afresh every time rather than held, so locking, unlocking and
    // switching account all take effect without anybody having to remember to
    // rebuild this.
    account: () => (wallet.status().unlocked ? wallet.account() : null),
    onDamaged: (name, reason) => console.error(`local state "${name}" is unreadable: ${reason}`)
  })

  /**
   * The worker's keystore password, sealed under the wallet account.
   *
   * It used to sit in settings.json in the clear, written `0600` and called
   * protected — but that password is the only thing between anybody holding the
   * keystore file and the 50,000 LCAI stake, and the settings file was writable
   * from the renderer, the least trusted side of the process boundary. It now
   * lives where the room registry and local state live: sealed under a key
   * derived from the wallet, unreadable while the wallet is locked.
   *
   * The consequence is deliberate: starting or registering a worker requires an
   * unlocked wallet. A plaintext `workerPassword` left in settings.json by an
   * older version is sealed and removed on the first unlock — see
   * useWalletInRooms.
   */
  const workerSecrets = new SealedStore(fileByteStore(path.join(chatDir, 'worker')), {
    purpose: 'worker secrets',
    account: () => (wallet.status().unlocked ? wallet.account() : null),
    onDamaged: (name, reason) => console.error(`worker secret "${name}" is unreadable: ${reason}`)
  })

  /**
   * Adopts a freshly verified keystore password: seals it under the wallet and
   * removes any plaintext copy still sitting in settings.
   *
   * Throws when the wallet is locked, because a password that cannot be sealed
   * must not be adopted — the alternative is writing it somewhere unsealed,
   * which is the bug this fixes.
   */
  function adoptWorkerPassword(password) {
    if (!workerSecrets.write(WORKER_PASSWORD_DOC, password)) {
      throw new Error('the wallet must be unlocked to set the worker keystore password')
    }

    const values = settings.values()
    if (typeof values.workerPassword === 'string') {
      const next = { ...values }
      delete next.workerPassword
      settings.save(next)
    }
  }

  /**
   * Seals a plaintext `workerPassword` an older version left in settings.json.
   *
   * Only possible once the wallet is unlocked, which is why this is called from
   * the wallet binding rather than at boot.
   */
  function migrate() {
    migrateWorkerPassword({
      secrets: workerSecrets,
      settings: settings.values(),
      saveSettings: (next) => settings.save(next)
    })
  }

  return {
    localState,
    keystorePassword: () => readWorkerPassword(workerSecrets, process.env),
    adopt: adoptWorkerPassword,
    migrate
  }
}
