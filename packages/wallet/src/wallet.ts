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

/**
 * The word that stands in for a password nobody has any more.
 *
 * A wallet removable only by its password is one that somebody who has
 * forgotten theirs can never get past, and the screen asking for that password
 * is the only screen left to them — the application is finished, for that
 * person, permanently. Typing this is the other proof, and it proves something
 * weaker on purpose: that a person is present and read the sentence, rather
 * than that they own what they are about to destroy. Nothing stronger is
 * available to offer them. The vault is already on the disk of whoever is
 * asking, the phrase inside it is what an attacker would have come for, and
 * this destroys that phrase rather than revealing it.
 *
 * Exported so that everything quoting the word quotes one value. It also
 * travels in the `wallet.replacePreview` reply, because the renderer is
 * sandboxed and cannot import from this workspace: a literal typed there would
 * be a second copy that nothing keeps in step with this one.
 */
export const REPLACE_CONFIRMATION = 'REPLACE'

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

/**
 * A status from something that could have replaced a wallet, saying whether it did.
 *
 * Kept apart from `WalletStatus` because only `create` and `importPhrase` can
 * replace anything, and a field that reads false on every other status is one
 * an interface soon stops reading.
 */
export interface ReplacementStatus extends WalletStatus {
  /**
   * Whether a wallet already on this machine was destroyed to reach this one.
   *
   * Worth saying out loud wherever it is true. It is the last moment anybody
   * can notice: afterwards the phrase that was here is gone, and nothing left
   * on the machine remembers that it ever existed.
   */
  readonly replaced: boolean
}

/** How a caller says it means to destroy a wallet that is already here. */
export interface ReplaceOptions {
  /**
   * {@link REPLACE_CONFIRMATION}, typed exactly, or nothing at all.
   *
   * Only consulted when a wallet is already here. A first wallet displaces
   * nothing and needs nobody's permission to exist.
   */
  readonly confirmation?: string
}

/** Either of the two proofs that removing the wallet was meant. */
export interface RemoveOptions extends ReplaceOptions {
  /** The vault's password, which proves ownership rather than mere presence. */
  readonly password?: string
}

/** What creating a wallet hands back. The phrase is shown once and not stored elsewhere. */
export interface CreatedWallet {
  readonly status: ReplacementStatus
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

/**
 * Whether somebody typed the confirmation, and typed it exactly.
 *
 * Neither trimmed nor case-folded, deliberately. This is not a field carrying
 * data that happened to arrive untidy; it is the deliberation itself, and every
 * leniency extended here lowers the bar it exists to raise. ` REPLACE ` is what
 * a paste produces and `replace` is what a hurry produces, while somebody
 * reading the sentence and typing the word produces neither. Strictness costs
 * that person nothing and costs the other one a second attempt, which is the
 * whole point of asking.
 */
function confirms(confirmation: string | undefined): boolean {
  return confirmation === REPLACE_CONFIRMATION
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
   * Whether this call is displacing a wallet, refusing unless somebody said so.
   *
   * The vault already here is left exactly where it is. What replaces it is
   * written over it further down, once the replacement has been proved to
   * open — clearing first and writing after leaves a moment with no wallet on
   * disk at all, and a process that stops in that moment has destroyed one
   * phrase without having written the one meant to succeed it.
   */
  #displacing(confirmation: string | undefined, refusal: string): boolean {
    if (this.#store.read() === null) return false
    if (!confirms(confirmation)) throw new WalletError(refusal)
    return true
  }

  /**
   * Generates a phrase, seals it, and returns it once.
   *
   * The caller is expected to show it and then forget it. Nothing here writes
   * it anywhere except the encrypted vault, so a caller that discards it
   * without the user writing it down has produced a wallet nobody can recover —
   * which is why onboarding asks for words back before continuing.
   *
   * A wallet already on this machine is refused unless the caller passes
   * {@link REPLACE_CONFIRMATION}, and then the new vault is written over the
   * old one with `status.replaced` saying so. **The phrase that was there is
   * gone**, along with every account derived from it, and nothing in this
   * package can bring it back.
   */
  create(password: string, options: ReplaceOptions = {}): CreatedWallet {
    const replaced = this.#displacing(
      options.confirmation,
      'a wallet already exists. Remove it deliberately before creating another.'
    )

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
    return { status: { ...this.status(), replaced }, phrase }
  }

  /**
   * Restores from a phrase written down elsewhere.
   *
   * Displaces a wallet already here on the same terms as {@link create}, and
   * for a better reason: restoring the phrase is precisely what somebody
   * locked out of this machine came here to do, and the wallet in the way is
   * the one they cannot open.
   */
  importPhrase(phrase: string, password: string, options: ReplaceOptions = {}): ReplacementStatus {
    const replaced = this.#displacing(
      options.confirmation,
      'a wallet already exists. Remove it deliberately before importing another.'
    )

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
    return { ...this.status(), replaced }
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

  /**
   * Removes the vault, on proof that whoever asked meant it.
   *
   * Either proof does, and they are not equals. The password shows ownership,
   * so a caller that offers one is held to it rather than allowed to slide
   * down to the weaker check on a typo — which means a screen asking for
   * {@link REPLACE_CONFIRMATION} must send that and nothing else.
   *
   * The confirmation shows only that a person read the sentence and typed a
   * word. That is all somebody who has forgotten their password has left, and
   * refusing them would mean an application whose one remaining screen asks
   * for the single thing they do not have. Nothing here is a secret an
   * attacker wants: they already hold the file, and this destroys the phrase
   * rather than handing it over.
   *
   * An empty password counts as none. A box left untouched arrives as `''`,
   * and answering "wrong password" to somebody who never typed one would bury
   * the confirmation they did type; no password of that length opens a vault
   * anyway, since `seal` refuses anything under eight characters.
   */
  remove(options: RemoveOptions = {}): WalletStatus {
    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet to remove')

    const password = options.password ?? ''
    if (password !== '') {
      open(vault, password)
    } else if (!confirms(options.confirmation)) {
      throw new WalletError(
        `removing a wallet takes either its password or the word ${REPLACE_CONFIRMATION}, typed exactly as it is written here.`
      )
    }

    this.#store.clear()
    this.#account = null
    this.#index = 0
    return this.status()
  }
}

export { VaultError, toChecksumAddress, keccak256 }
