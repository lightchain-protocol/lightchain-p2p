import '#globals'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { scrypt } from '@noble/hashes/scrypt.js'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { toAddress, toBytes, toHex } from '@lcai-p2p/chain'
import { secp256k1 } from '@noble/curves/secp256k1.js'

/**
 * The encrypted vault holding a recovery phrase.
 *
 * ## Why not a keystore
 *
 * Keystore V3 has a slot for a private key and none for a seed, so a wallet
 * that wants a phrase cannot use it as its root. That is fine, because the two
 * do different jobs: **the phrase is the portable backup** — twelve words that
 * restore in MetaMask, Rabby or a Ledger — and the vault is only local
 * convenience so the phrase does not have to be typed every time. Per-account
 * V3 export still exists for tools that want a file.
 *
 * ## Why these primitives
 *
 * The cipher is close to irrelevant against the threat that matters, which is
 * someone stealing this file and guessing the password offline. Both AES-256-GCM
 * and XChaCha20 are unbreakable; what an attacker actually pays is the KDF.
 *
 * Measured on this runtime, scrypt buys roughly four times the memory per
 * second of user-visible delay that Argon2id does, because Argon2id's
 * pure-JavaScript implementation is slow. Memory per guess is the thing a GPU
 * farm cannot parallelise away, so scrypt wins here despite Argon2id being the
 * better design on paper.
 *
 * The parameters are **written into the vault** rather than assumed, so they can
 * be raised later, or lowered on a phone, without orphaning wallets already in
 * the wild.
 */

export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

/** Matches the keystore, so there is one number to reason about across the product. */
export const SCRYPT_N = 262_144
export const SCRYPT_R = 8
export const SCRYPT_P = 1

/** The standard Ethereum account path. A phrase saved here restores anywhere. */
export const ACCOUNT_PATH = "m/44'/60'/0'/0"

/**
 * The highest account this wallet will derive.
 *
 * BIP-32 offers a little over two billion children at this level, and almost
 * none of them are reachable. A phrase restored somewhere else is searched by
 * walking forward from zero and stopping after a run of unused accounts —
 * twenty of them, by BIP-44's convention — so an account at index nine million
 * is not a high-numbered account, it is one no other wallet will ever show its
 * owner again. The cap sits far above any plausible use and far below the
 * numbers that arrive by accident: a timestamp, a balance in wei, or a value
 * that was meant to be a length.
 */
export const MAX_ACCOUNT_INDEX = 999

/** Whether a number names an account. Useful to an interface before it asks. */
export function isAccountIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= MAX_ACCOUNT_INDEX
}

export interface Vault {
  /**
   * 1 holds the phrase alone. 2 holds a phrase and a BIP-39 passphrase, as JSON.
   *
   * A vault is only written as 2 when there is a passphrase to put in it, so
   * every wallet that does not use one stays byte-identical to what it was and
   * stays readable by a build that predates this. The upgrade is not a
   * migration anybody is dragged through; it happens to the wallets that need
   * it, at the moment they need it.
   */
  readonly version: 1 | 2
  readonly kdf: 'scrypt'
  readonly kdfparams: {
    readonly n: number
    readonly r: number
    readonly p: number
    readonly dklen: 32
    readonly salt: string
  }
  readonly cipher: 'aes-256-gcm'
  readonly iv: string
  readonly tag: string
  readonly ciphertext: string
}

/**
 * Everything needed to derive a key, which is not always just the phrase.
 *
 * BIP-39 allows a passphrase that is mixed into the seed — the "25th word".
 * It is not a second password: it produces an entirely different, equally
 * valid wallet, and there is no checksum or error that reveals a wrong one.
 * Someone importing a phrase from a wallet that used one gets an empty account
 * at a plausible-looking address unless they can bring the passphrase too.
 *
 * That is why it is supported on import. It is deliberately not offered on
 * create: a phrase written on paper is recoverable, and a phrase plus a
 * passphrase held only in someone's head is recoverable right up until it
 * is not.
 */
export interface Secret {
  readonly phrase: string
  /** Empty when there is none, which is the ordinary case. */
  readonly passphrase: string
}

function derive(password: string, salt: Uint8Array, params: { n: number; r: number; p: number }) {
  return scrypt(new TextEncoder().encode(password), salt, {
    N: params.n,
    r: params.r,
    p: params.p,
    dkLen: 32
  })
}

/** Twelve words. Enough entropy, and materially easier to transcribe than 24. */
export function generatePhrase(): string {
  return generateMnemonic(wordlist, 128)
}

/**
 * Whether a phrase is well-formed.
 *
 * BIP-39 carries a checksum, which is what turns a mistyped word into a
 * rejection rather than into a different, empty wallet.
 */
export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(normalise(phrase), wordlist)
}

/** Lowercase, single-spaced, trimmed — what someone typing from paper produces. */
export function normalise(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function seal(phrase: string, password: string, passphrase = ''): Vault {
  const clean = normalise(phrase)
  if (!isValidPhrase(clean)) throw new VaultError('that is not a valid recovery phrase')
  if (password.length < 8) throw new VaultError('the password must be at least 8 characters')

  const salt = new Uint8Array(randomBytes(32))
  const iv = new Uint8Array(randomBytes(12))
  const key = derive(password, salt, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })

  // Version 1 stays the bare phrase so that a wallet without a passphrase
  // produces exactly the file it always did.
  const version = passphrase === '' ? 1 : 2
  const payload = version === 1 ? clean : JSON.stringify({ phrase: clean, passphrase })

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()])

  return {
    version,
    kdf: 'scrypt',
    kdfparams: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dklen: 32, salt: toHex(salt) },
    cipher: 'aes-256-gcm',
    iv: toHex(iv),
    tag: toHex(new Uint8Array(cipher.getAuthTag())),
    ciphertext: toHex(new Uint8Array(ciphertext))
  }
}

export function open(vault: unknown, password: string): Secret {
  const v = validate(vault)
  const key = derive(password, toBytes(v.kdfparams.salt), v.kdfparams)

  const decipher = createDecipheriv('aes-256-gcm', key, toBytes(v.iv))
  decipher.setAuthTag(Buffer.from(toBytes(v.tag)))

  let plaintext: string
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(toBytes(v.ciphertext))),
      decipher.final()
    ]).toString('utf8')
  } catch {
    // GCM authenticates, so a wrong password and a tampered file both land
    // here. They are reported identically: telling an attacker which one they
    // got right is free information.
    throw new VaultError('wrong password, or the vault has been altered')
  }

  const secret = v.version === 1 ? { phrase: plaintext, passphrase: '' } : parsePayload(plaintext)

  if (!isValidPhrase(secret.phrase)) {
    throw new VaultError('the vault did not contain a valid phrase')
  }
  return secret
}

/**
 * A version 2 payload, which is JSON rather than a phrase.
 *
 * Anything malformed is reported as a bad vault rather than as a parse error.
 * The bytes decrypted and authenticated, so this is not an attacker's doing —
 * it is a file this code wrote and can no longer read, and the shape of the
 * JSON is not information a user can act on.
 */
function parsePayload(plaintext: string): Secret {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new VaultError('the vault did not contain a readable phrase')
  }

  const p = parsed as Secret
  if (!p || typeof p.phrase !== 'string' || typeof p.passphrase !== 'string') {
    throw new VaultError('the vault did not contain a readable phrase')
  }

  return { phrase: p.phrase, passphrase: p.passphrase }
}

/**
 * The same shape, with nothing about it believed yet. See the note on
 * `UnvalidatedKeystore` in keystore.ts: asserting the type on the way in tells
 * the compiler the answer to the question this function is asking, and every
 * rejection branch below then narrows to `never`.
 */
interface UnvalidatedVault {
  version?: unknown
  kdf?: unknown
  cipher?: unknown
  kdfparams?: { dklen?: unknown; n?: unknown; p?: unknown; r?: unknown }
}

function validate(value: unknown): Vault {
  const v = value as UnvalidatedVault
  if (!v || typeof v !== 'object') throw new VaultError('vault must be an object')
  if (v.version !== 1 && v.version !== 2) {
    throw new VaultError(`unsupported vault version: ${String(v.version)}`)
  }
  if (v.kdf !== 'scrypt') throw new VaultError(`unsupported kdf: ${String(v.kdf)}`)
  if (v.cipher !== 'aes-256-gcm') throw new VaultError(`unsupported cipher: ${String(v.cipher)}`)

  const p = v.kdfparams
  if (!p || typeof p.n !== 'number' || typeof p.r !== 'number' || typeof p.p !== 'number') {
    throw new VaultError('vault kdfparams are incomplete')
  }
  // Low parameters would decrypt instantly and protect nothing; absurd ones
  // would exhaust memory on a file anyone can hand you.
  if (p.n < 16_384 || p.n > 1 << 22) throw new VaultError(`scrypt N out of range: ${p.n}`)
  if (p.dklen !== 32) throw new VaultError(`unsupported dklen: ${String(p.dklen)}`)

  // Earned now, rather than assumed at the top.
  return value as Vault
}

/**
 * The private key for one account of a phrase.
 *
 * Index 0 at `m/44'/60'/0'/0/0` is what every wallet calls "Account 1", so the
 * first address here is the first address anywhere else the phrase is restored.
 *
 * Coin type 60 is Ethereum's, and it is what every EVM chain uses — the same
 * key signs on Lightchain, Ethereum, Base, Arbitrum, Polygon and BSC, and the
 * address is the same on all of them. There is nothing per-chain to derive.
 *
 * The passphrase is passed through unmodified apart from the NFKD the BIP-39
 * library applies. It is emphatically not run through `normalise`: case and
 * spacing are significant, and lowercasing one would silently derive a
 * different wallet from the one it was written for.
 */
/**
 * The account-level public key, from which every account's address follows.
 *
 * `ACCOUNT_PATH` ends at the last hardened step, and the account index appended
 * to it is not hardened — which is the whole point of the BIP-44 layout. So the
 * extended *public* key at that node derives every address this phrase will
 * ever have, and derives none of their private keys.
 *
 * That distinction is what lets an unlocked wallet list its accounts without
 * being handed a password again. Holding this is not the same as holding the
 * phrase: it names the addresses and cannot spend from any of them.
 */
export function accountsPublicKey(phrase: string, passphrase = ''): string {
  const clean = normalise(phrase)
  if (!isValidPhrase(clean)) throw new VaultError('that is not a valid recovery phrase')

  const seed = mnemonicToSeedSync(clean, passphrase)
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH).publicExtendedKey
}

/**
 * The address at an index, from the account-level public key alone.
 *
 * No secret goes in and none comes out. `toAddress` wants the uncompressed
 * point and BIP-32 stores the compressed one, so the point is expanded here
 * rather than at every call site.
 */
export function addressFromAccountsKey(publicKey: string, index = 0): string {
  if (!isAccountIndex(index)) {
    throw new VaultError(
      `account index must be a whole number between 0 and ${MAX_ACCOUNT_INDEX}, got ${index}`
    )
  }

  const child = HDKey.fromExtendedKey(publicKey).deriveChild(index)
  if (!child.publicKey) throw new VaultError('derivation produced no public key')

  return toAddress(secp256k1.Point.fromBytes(child.publicKey).toBytes(false))
}

export function derivePrivateKey(phrase: string, index = 0, passphrase = ''): string {
  if (!isAccountIndex(index)) {
    throw new VaultError(
      `account index must be a whole number between 0 and ${MAX_ACCOUNT_INDEX}, got ${index}`
    )
  }

  const clean = normalise(phrase)
  if (!isValidPhrase(clean)) throw new VaultError('that is not a valid recovery phrase')

  const seed = mnemonicToSeedSync(clean, passphrase)
  const key = HDKey.fromMasterSeed(seed).derive(`${ACCOUNT_PATH}/${index}`)
  if (!key.privateKey) throw new VaultError('derivation produced no private key')

  return toHex(key.privateKey)
}
