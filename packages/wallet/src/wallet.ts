import {
  fromPrivateKey,
  keccak256,
  toChecksumAddress,
  type Account,
  type Transaction
} from '@lcai-p2p/chain'
import { encrypt as encryptKeystore, type KeystoreV3 } from './keystore.js'
import {
  ACCOUNT_PATH,
  MAX_ACCOUNT_INDEX,
  VaultError,
  derivePrivateKey,
  generatePhrase,
  isAccountIndex,
  isValidPhrase,
  normalise,
  open,
  seal,
  type Vault
} from './vault.js'

/**
 * One recovery phrase, locked or unlocked.
 *
 * The phrase is the root secret and the only real backup. It exists in the
 * encrypted vault, and briefly in the caller's hands at the moment it is
 * created — after that, seeing it again costs the password.
 *
 * While unlocked the wallet holds a derived `Account` and **not** the phrase.
 * That is deliberate: an unlocked wallet can sign, which is what it is for, but
 * it cannot hand over the thing that would let someone drain every account
 * derived from it.
 *
 * One phrase holds many accounts and exactly one of them is active — the first,
 * unless something asked for another. They are separate identities rather than
 * separate addresses for one, which matters more than it sounds: see
 * `switchAccount`.
 */

export class WalletError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WalletError'
  }
}

export interface VaultStore {
  read(): Vault | null
  write(vault: Vault): void
  clear(): void
}

export interface WalletStatus {
  readonly exists: boolean
  readonly unlocked: boolean
  /** Only known while unlocked: the address lives in the phrase, not beside it. */
  readonly address: string | null
  /**
   * Which account of the phrase is in use. Zero unless something switched it,
   * and zero again whenever the wallet is locked.
   */
  readonly accountIndex: number
  /** The derivation path, so a user can restore elsewhere without guessing. */
  readonly path: string
}

/** What creating a wallet hands back. The phrase is shown once and not stored elsewhere. */
export interface CreatedWallet {
  readonly status: WalletStatus
  readonly phrase: string
}

export function memoryVaultStore(initial: Vault | null = null): VaultStore {
  let held = initial
  return {
    read: () => held,
    write: (vault) => {
      held = vault
    },
    clear: () => {
      held = null
    }
  }
}

/**
 * Refuses an index before anything expensive happens.
 *
 * Opening the vault costs half a second of scrypt, and there is no sense
 * spending it to discover that the caller passed a fraction or a timestamp.
 */
function requireAccountIndex(index: number): void {
  if (!isAccountIndex(index)) {
    throw new WalletError(
      `account index must be a whole number between 0 and ${MAX_ACCOUNT_INDEX}, got ${index}`
    )
  }
}

export class Wallet {
  readonly #store: VaultStore
  #account: Account | null = null
  #index = 0

  constructor(store: VaultStore) {
    this.#store = store
  }

  status(): WalletStatus {
    return {
      exists: this.#store.read() !== null,
      unlocked: this.#account !== null,
      address: this.#account?.address ?? null,
      accountIndex: this.#index,
      path: `${ACCOUNT_PATH}/${this.#index}`
    }
  }

  /** Derivation and the record of what was derived, kept together. */
  #use(phrase: string, index: number): void {
    this.#account = fromPrivateKey(derivePrivateKey(phrase, index))
    this.#index = index
  }

  /**
   * Generates a phrase, seals it, and returns it once.
   *
   * The caller is expected to show it and then forget it. Nothing here writes
   * it anywhere except the encrypted vault, so a caller that discards it
   * without the user writing it down has produced a wallet nobody can recover —
   * which is why onboarding asks for words back before continuing.
   */
  create(password: string): CreatedWallet {
    if (this.#store.read() !== null) {
      throw new WalletError(
        'a wallet already exists. Remove it deliberately before creating another.'
      )
    }

    const phrase = generatePhrase()
    const vault = seal(phrase, password)

    // Opened before it is trusted. A vault that will not open is otherwise
    // discovered when someone needs it, which is the worst possible moment.
    if (open(vault, password) !== phrase) {
      throw new WalletError(
        'the vault did not reopen to the phrase it was given; nothing was saved'
      )
    }

    this.#store.write(vault)
    this.#use(phrase, 0)
    return { status: this.status(), phrase }
  }

  /** Restores from a phrase written down elsewhere. */
  importPhrase(phrase: string, password: string): WalletStatus {
    if (this.#store.read() !== null) {
      throw new WalletError(
        'a wallet already exists. Remove it deliberately before importing another.'
      )
    }

    const clean = normalise(phrase)
    if (!isValidPhrase(clean)) {
      // The BIP-39 checksum catches a mistyped word. Accepting one anyway would
      // silently produce a different, empty wallet.
      throw new WalletError(
        'that phrase is not valid. Check for a mistyped or missing word — the order matters.'
      )
    }

    const vault = seal(clean, password)
    if (open(vault, password) !== clean) {
      throw new WalletError(
        'the vault did not reopen to the phrase it was given; nothing was saved'
      )
    }

    this.#store.write(vault)
    this.#use(clean, 0)
    return this.status()
  }

  /**
   * Opens the vault and derives an account from the phrase inside.
   *
   * `index` chooses which account, and defaults to the first — the one every
   * other wallet calls "Account 1", so a caller that never mentions an index
   * gets what it has always got. Anything else is a deliberate choice of
   * identity, with the consequences described on `switchAccount`.
   */
  unlock(password: string, index = 0): WalletStatus {
    requireAccountIndex(index)

    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet to unlock')

    this.#use(open(vault, password), index)
    return this.status()
  }

  /**
   * Moves to another account of the same phrase.
   *
   * It costs the password even though the wallet is already unlocked, and
   * unavoidably so: an unlocked wallet holds a derived account rather than the
   * phrase, so there is nothing in memory a second account could come from.
   * That is the same reason `addressAt` asks for one.
   *
   * **Everything sealed under the old account stops opening.** `deriveKey`
   * takes its key from a signature by whichever account is active, so the room
   * registry, the transcript log and every sealed document belong to the
   * account that wrote them. After switching, the room list is empty, history
   * is empty, and local preferences are back to their defaults. Nothing has
   * been lost and nothing has been deleted — switch back and all of it
   * returns. This is what a second account is meant to be: a separate identity
   * with its own rooms and its own conversations, rather than a second address
   * for the same ones. It is also the single most surprising thing this wallet
   * does, so an interface offering the switch should say so beforehand rather
   * than leave someone to conclude their history was destroyed.
   */
  switchAccount(password: string, index: number): WalletStatus {
    return this.unlock(password, index)
  }

  /**
   * Forgets the account, and with it which account was active.
   *
   * The index returns to zero rather than being kept. There is nowhere to keep
   * it that survives the process — a fresh `Wallet` always starts at zero — so
   * a lock that remembered would come back to account three this afternoon and
   * to account zero tomorrow, and the difference is which identity's rooms and
   * history appear. Predictable beats convenient when that is what is at
   * stake; a caller that wants to return to the same account passes the index
   * to `unlock`.
   */
  lock(): WalletStatus {
    this.#account = null
    this.#index = 0
    return this.status()
  }

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
   * The phrase again, for someone backing it up late.
   *
   * Costs the password even when unlocked. An unlocked wallet is left unlocked
   * on a desk; the phrase is every account forever, and it should take more
   * than proximity to see it.
   */
  revealPhrase(password: string): string {
    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet')
    return open(vault, password)
  }

  /** The address of any account, without switching to it. */
  addressAt(password: string, index: number): string {
    const phrase = this.revealPhrase(password)
    return fromPrivateKey(derivePrivateKey(phrase, index)).address
  }

  /**
   * A keystore V3 file for one account.
   *
   * The phrase is the portable backup; this is for tools that want a file —
   * Foundry, geth. It contains one account's key and cannot reconstruct the
   * others, which is a feature rather than a limitation.
   */
  exportKeystore(password: string, index = 0): KeystoreV3 {
    const phrase = this.revealPhrase(password)
    return encryptKeystore(derivePrivateKey(phrase, index), password)
  }

  /**
   * Reseals the vault under a new password.
   *
   * The phrase does not change, so neither does the address, nor anything
   * derived from the key — transcripts and the room registry are sealed with a
   * signature rather than with the password, and stay readable. That is the
   * point of deriving them that way: a password should be changeable without
   * abandoning everything it happened to be protecting.
   *
   * The new vault is opened before the old one is replaced. A vault that will
   * not open is otherwise discovered at the next unlock, by which time the
   * password that would have opened it is the one just discarded.
   */
  changePassword(current: string, next: string): WalletStatus {
    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet')

    const phrase = open(vault, current)
    if (next === current) throw new WalletError('that is the password it already has')

    const resealed = seal(phrase, next)
    if (open(resealed, next) !== phrase) {
      throw new WalletError('the new vault did not reopen to the same phrase; nothing was changed')
    }

    this.#store.write(resealed)
    return this.status()
  }

  /** Removes the vault. The password is required so it cannot be wiped in passing. */
  remove(password: string): WalletStatus {
    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet to remove')

    open(vault, password)
    this.#store.clear()
    this.#account = null
    this.#index = 0
    return this.status()
  }
}

export { VaultError, toChecksumAddress, keccak256 }
