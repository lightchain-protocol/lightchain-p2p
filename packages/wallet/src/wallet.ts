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
  accountsPublicKey,
  addressFromAccountsKey,
  derivePrivateKey,
  generatePhrase,
  isAccountIndex,
  isValidPhrase,
  normalise,
  open,
  seal,
  type Secret,
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
  /**
   * Whether this wallet's seed is a phrase plus a passphrase.
   *
   * Worth surfacing, because the phrase alone will not restore it and somebody
   * who wrote down twelve words believing otherwise has a backup that does not
   * work. Says only that one exists — never what it is.
   */
  readonly hasPassphrase: boolean
  /** How long the wallet may sit idle before locking itself, in milliseconds. */
  readonly autoLockMs: number
  /**
   * Idle milliseconds, or null while locked.
   *
   * Lets an interface warn before the lock rather than surprise somebody
   * mid-sentence with a screen asking for a password.
   */
  readonly idleMs: number | null
}

/**
 * How long an unlocked wallet stays unlocked with nothing happening.
 *
 * Fifteen minutes is the compromise every wallet lands near. Shorter and it
 * interrupts somebody reading a long thread; longer and an unlocked wallet on
 * an unattended desk stops being a hypothetical.
 */
export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000

/** Off. Nameable, so nothing has to compare against a bare zero to know what it means. */
export const AUTO_LOCK_OFF = 0

export interface WalletOptions {
  /** Defaults to {@link DEFAULT_AUTO_LOCK_MS}. {@link AUTO_LOCK_OFF} disables it. */
  readonly autoLockMs?: number
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

/** Importing can also carry the passphrase the phrase was created with. */
export interface ImportOptions extends ReplaceOptions {
  /** BIP-39's 25th word. Case and spacing are significant; nothing can verify it. */
  readonly passphrase?: string
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

  /**
   * The account-level public key of the open wallet, and only while it is open.
   *
   * This names every address the phrase will ever have and can spend from none
   * of them, which is exactly the difference between listing accounts and using
   * one. Before this, an interface that wanted to show somebody their accounts
   * had to ask for the password purely to read public information — on a screen
   * they had already unlocked.
   *
   * Dropped by `lock()` with everything else. It is not a secret in the sense
   * the phrase is, but it is a record of what this person holds, and a locked
   * wallet should not answer questions about that.
   */
  #accountsKey: string | null = null
  #hasPassphrase = false
  #autoLockMs: number
  /** When the account was last derived or used, by the clock the caller passes in. */
  #lastUsed = 0

  constructor(store: VaultStore, options: WalletOptions = {}) {
    this.#store = store
    this.#autoLockMs = options.autoLockMs ?? DEFAULT_AUTO_LOCK_MS
  }

  status(now = Date.now()): WalletStatus {
    return {
      exists: this.#store.read() !== null,
      unlocked: this.#account !== null,
      address: this.#account?.address ?? null,
      accountIndex: this.#index,
      path: `${ACCOUNT_PATH}/${this.#index}`,
      hasPassphrase: this.#hasPassphrase,
      autoLockMs: this.#autoLockMs,
      idleMs: this.#account === null ? null : Math.max(0, now - this.#lastUsed)
    }
  }

  /**
   * Changes the idle timeout, and restarts the clock.
   *
   * Restarting matters: shortening the timeout to five minutes while a wallet
   * has already sat idle for ten would otherwise lock it on the spot, which
   * reads as the setting having broken something.
   */
  setAutoLock(ms: number, now = Date.now()): WalletStatus {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new WalletError('the auto-lock time must be zero or a positive number of milliseconds')
    }

    this.#autoLockMs = ms
    this.#lastUsed = now
    return this.status(now)
  }

  /**
   * Locks if the wallet has been idle past the timeout, and says whether it did.
   *
   * The clock arrives as an argument and the timer lives outside this package.
   * A `setInterval` in here would keep a Bare process alive on its own and be
   * untestable without waiting in real time; a caller that already has a poll
   * loop can pass a number and get a deterministic answer.
   */
  lockIfIdle(now = Date.now()): boolean {
    if (this.#account === null) return false
    if (this.#autoLockMs === AUTO_LOCK_OFF) return false
    if (now - this.#lastUsed < this.#autoLockMs) return false

    this.lock()
    return true
  }

  /**
   * Restarts the idle clock without needing the key.
   *
   * For activity that should count as presence but does not sign anything —
   * reading a room, switching a panel. Deliberately separate from `account()`
   * so that "the user is here" and "something used the key" stay distinct.
   */
  touch(now = Date.now()): void {
    if (this.#account !== null) this.#lastUsed = now
  }

  /** Derivation and the record of what was derived, kept together. */
  #use(secret: Secret, index: number, now = Date.now()): void {
    this.#account = fromPrivateKey(derivePrivateKey(secret.phrase, index, secret.passphrase))
    this.#accountsKey = accountsPublicKey(secret.phrase, secret.passphrase)
    this.#index = index
    this.#hasPassphrase = secret.passphrase !== ''
    this.#lastUsed = now
  }

  /**
   * The first `count` addresses of this phrase, while the wallet is open.
   *
   * No password, because none is needed: these come from the account-level
   * public key and are public information about a wallet whose owner is
   * already here. Switching to one still costs the password — that needs a
   * private key, and an unlocked wallet holds only the active account's.
   */
  addresses(count: number): { index: number; address: string }[] {
    if (!this.#accountsKey) throw new WalletError('the wallet is locked')

    return Array.from({ length: count }, (unused, index) => ({
      index,
      address: addressFromAccountsKey(this.#accountsKey as string, index)
    }))
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
    if (open(vault, password).phrase !== phrase) {
      throw new WalletError(
        'the vault did not reopen to the phrase it was given; nothing was saved'
      )
    }

    this.#store.write(vault)
    this.#use({ phrase, passphrase: '' }, 0)
    return { status: { ...this.status(), replaced }, phrase }
  }

  /**
   * Restores from a phrase written down elsewhere.
   *
   * Displaces a wallet already here on the same terms as {@link create}, and
   * for a better reason: restoring the phrase is precisely what somebody
   * locked out of this machine came here to do, and the wallet in the way is
   * the one they cannot open.
   *
   * `passphrase` is BIP-39's optional 25th word, for a phrase that was created
   * with one somewhere else. **Nothing can check it.** A wrong passphrase is
   * not an error — it derives a different, valid, empty wallet at a
   * plausible-looking address. An interface offering the field should show the
   * resulting address and let the user recognise it, because that is the only
   * confirmation available.
   */
  importPhrase(phrase: string, password: string, options: ImportOptions = {}): ReplacementStatus {
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

    const passphrase = options.passphrase ?? ''
    const vault = seal(clean, password, passphrase)

    const reopened = open(vault, password)
    if (reopened.phrase !== clean || reopened.passphrase !== passphrase) {
      throw new WalletError(
        'the vault did not reopen to the phrase it was given; nothing was saved'
      )
    }

    this.#store.write(vault)
    this.#use(reopened, 0)
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
    this.#accountsKey = null
    this.#index = 0
    this.#hasPassphrase = false
    return this.status()
  }

  /**
   * The account, if the wallet is open — and using it counts as being here.
   *
   * Every read of the key restarts the idle clock, so a wallet that is signing
   * is a wallet nobody has walked away from. The lock is for the case where
   * they have.
   */
  account(now = Date.now()): Account {
    if (!this.#account) throw new WalletError('the wallet is locked')
    this.#lastUsed = now
    return this.#account
  }

  signTransaction(tx: Transaction): string {
    return this.account().signTransaction(tx)
  }

  signMessage(message: string): string {
    return this.account().signMessage(message)
  }

  /**
   * Checks a password without doing anything else.
   *
   * The proof that somebody is present before the key moves real money. It
   * costs the same scrypt as an unlock, which is the point: it is the only
   * check available that a compromised window cannot fake, because the answer
   * comes from the vault rather than from the window's own say-so.
   */
  verifyPassword(password: string, now = Date.now()): boolean {
    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet')

    try {
      open(vault, password)
    } catch {
      return false
    }

    this.touch(now)
    return true
  }

  /**
   * The phrase again, for someone backing it up late.
   *
   * Costs the password even when unlocked. An unlocked wallet is left unlocked
   * on a desk; the phrase is every account forever, and it should take more
   * than proximity to see it.
   */
  revealPhrase(password: string): string {
    return this.revealSecret(password).phrase
  }

  /**
   * The phrase and its passphrase together.
   *
   * Separate from `revealPhrase` because most callers want the words to show
   * somebody, and only derivation wants both. Keeping them apart means a
   * caller has to reach for the passphrase deliberately rather than receive it
   * in a field it was not thinking about.
   */
  revealSecret(password: string): Secret {
    const vault = this.#store.read()
    if (!vault) throw new WalletError('there is no wallet')
    return open(vault, password)
  }

  /** The address of any account, without switching to it. */
  addressAt(password: string, index: number): string {
    const secret = this.revealSecret(password)
    return fromPrivateKey(derivePrivateKey(secret.phrase, index, secret.passphrase)).address
  }

  /**
   * A keystore V3 file for one account.
   *
   * The phrase is the portable backup; this is for tools that want a file —
   * Foundry, geth. It contains one account's key and cannot reconstruct the
   * others, which is a feature rather than a limitation.
   */
  exportKeystore(password: string, index = 0): KeystoreV3 {
    const secret = this.revealSecret(password)
    return encryptKeystore(derivePrivateKey(secret.phrase, index, secret.passphrase), password)
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

    const secret = open(vault, current)
    if (next === current) throw new WalletError('that is the password it already has')

    // The passphrase is carried across untouched. Losing it here would leave a
    // vault that opens under the new password onto a different, empty wallet.
    const resealed = seal(secret.phrase, next, secret.passphrase)
    const reopened = open(resealed, next)
    if (reopened.phrase !== secret.phrase || reopened.passphrase !== secret.passphrase) {
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
    this.#hasPassphrase = false
    return this.status()
  }
}

export { VaultError, toChecksumAddress, keccak256 }
