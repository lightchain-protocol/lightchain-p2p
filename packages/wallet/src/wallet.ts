import { randomBytes } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  fromPrivateKey,
  keccak256,
  toChecksumAddress,
  toHex,
  type Account,
  type Transaction
} from '@lcai-p2p/chain'
import { KeystoreError, addressOf, decrypt, encrypt, type KeystoreV3 } from './keystore.js'

/**
 * One key, locked or unlocked.
 *
 * The private key exists in two places and no others: inside the encrypted
 * keystore, and inside the `Account` closure while unlocked. It is never a
 * property of anything, never returned, and never crosses to a user interface —
 * a renderer sees an address and a lock state, which is all it can act on.
 *
 * Storage is injected rather than opened here, so the same code runs against a
 * file under Bare and against memory in a test.
 */

export class WalletError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WalletError'
  }
}

/** Where the keystore lives. Implementations are trivially small on purpose. */
export interface KeystoreStore {
  read(): KeystoreV3 | null
  write(keystore: KeystoreV3): void
  clear(): void
}

export interface WalletStatus {
  readonly exists: boolean
  readonly unlocked: boolean
  /** Known whenever a keystore exists, locked or not — it is not a secret. */
  readonly address: string | null
}

export function memoryStore(initial: KeystoreV3 | null = null): KeystoreStore {
  let held = initial
  return {
    read: () => held,
    write: (keystore) => {
      held = keystore
    },
    clear: () => {
      held = null
    }
  }
}

export class Wallet {
  readonly #store: KeystoreStore
  #account: Account | null = null

  constructor(store: KeystoreStore) {
    this.#store = store
  }

  status(): WalletStatus {
    const keystore = this.#store.read()
    // A keystore stores its address lowercased. Presenting it that way while a
    // signing account presents it checksummed makes one address look like two,
    // and the checksum is the only defence against a mistyped one.
    const stored = keystore ? addressOf(keystore) : null

    return {
      exists: keystore !== null,
      unlocked: this.#account !== null,
      address: this.#account?.address ?? (stored ? toChecksumAddress(stored, keccak256) : null)
    }
  }

  /**
   * Generates a key and encrypts it under `password`.
   *
   * Refuses when one already exists. Overwriting a keystore destroys the only
   * copy of a key that may hold funds, and "are you sure" belongs to a user
   * interface, not to the thing that would do it.
   */
  create(password: string): WalletStatus {
    if (this.#store.read() !== null) {
      throw new WalletError(
        'a wallet already exists. Remove it deliberately before creating another.'
      )
    }
    requirePassword(password)

    const privateKey = toHex(secp256k1.utils.randomSecretKey())
    const keystore = encrypt(privateKey, password)

    // Read it back before reporting success. A keystore that cannot be
    // decrypted is discovered when the user needs their key, which is the
    // worst possible time.
    const recovered = decrypt(keystore, password)
    if (recovered !== privateKey) {
      throw new WalletError(
        'the keystore did not decrypt to the key it was given; nothing was saved'
      )
    }

    this.#store.write(keystore)
    this.#account = fromPrivateKey(privateKey)
    return this.status()
  }

  /** Imports an existing key. The same verification applies. */
  importKey(privateKey: string, password: string): WalletStatus {
    if (this.#store.read() !== null) {
      throw new WalletError(
        'a wallet already exists. Remove it deliberately before importing another.'
      )
    }
    requirePassword(password)

    // Constructed first so an invalid key is rejected before spending half a
    // second on scrypt.
    const account = fromPrivateKey(privateKey)
    const keystore = encrypt(privateKey, password)

    if (decrypt(keystore, password) !== privateKey) {
      throw new WalletError(
        'the keystore did not decrypt to the key it was given; nothing was saved'
      )
    }

    this.#store.write(keystore)
    this.#account = account
    return this.status()
  }

  unlock(password: string): WalletStatus {
    const keystore = this.#store.read()
    if (!keystore) throw new WalletError('there is no wallet to unlock')

    // KeystoreError already reads correctly for a user — "wrong password, or
    // the keystore has been altered" — and deliberately does not say which.
    this.#account = fromPrivateKey(decrypt(keystore, password))
    return this.status()
  }

  lock(): WalletStatus {
    this.#account = null
    return this.status()
  }

  /** The unlocked account, for signing. Throws rather than returning null. */
  account(): Account {
    if (!this.#account) throw new WalletError('the wallet is locked')
    return this.#account
  }

  signTransaction(tx: Transaction): string {
    return this.account().signTransaction(tx)
  }

  signMessage(message: string): string {
    return this.account().signMessage(message)
  }

  /**
   * Exports the private key, given the password again.
   *
   * Asking a second time is the point: an unlocked wallet is left unlocked, and
   * revealing the key should require the same thing that created it rather than
   * whoever happens to be at the keyboard.
   */
  exportPrivateKey(password: string): string {
    const keystore = this.#store.read()
    if (!keystore) throw new WalletError('there is no wallet to export')
    return decrypt(keystore, password)
  }

  /** The keystore as JSON, for a backup. Encrypted, so it is safe to copy. */
  exportKeystore(): KeystoreV3 {
    const keystore = this.#store.read()
    if (!keystore) throw new WalletError('there is no wallet to export')
    return keystore
  }

  /** Removes the keystore. The password is required so a locked wallet cannot be wiped casually. */
  remove(password: string): WalletStatus {
    const keystore = this.#store.read()
    if (!keystore) throw new WalletError('there is no wallet to remove')

    decrypt(keystore, password)
    this.#store.clear()
    this.#account = null
    return this.status()
  }
}

function requirePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    // Not a policy about character classes, which mostly produces
    // `Password1!`. Length is what makes scrypt's cost per guess matter.
    throw new WalletError('the password must be at least 8 characters')
  }
}

export { KeystoreError, randomBytes }
