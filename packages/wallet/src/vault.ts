import '#globals'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { scrypt } from '@noble/hashes/scrypt.js'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { toBytes, toHex } from '@lcai-p2p/chain'

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

export interface Vault {
  readonly version: 1
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

export function seal(phrase: string, password: string): Vault {
  const clean = normalise(phrase)
  if (!isValidPhrase(clean)) throw new VaultError('that is not a valid recovery phrase')
  if (password.length < 8) throw new VaultError('the password must be at least 8 characters')

  const salt = new Uint8Array(randomBytes(32))
  const iv = new Uint8Array(randomBytes(12))
  const key = derive(password, salt, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(clean, 'utf8')), cipher.final()])

  return {
    version: 1,
    kdf: 'scrypt',
    kdfparams: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dklen: 32, salt: toHex(salt) },
    cipher: 'aes-256-gcm',
    iv: toHex(iv),
    tag: toHex(new Uint8Array(cipher.getAuthTag())),
    ciphertext: toHex(new Uint8Array(ciphertext))
  }
}

export function open(vault: unknown, password: string): string {
  const v = validate(vault)
  const key = derive(password, toBytes(v.kdfparams.salt), v.kdfparams)

  const decipher = createDecipheriv('aes-256-gcm', key, toBytes(v.iv))
  decipher.setAuthTag(Buffer.from(toBytes(v.tag)))

  let phrase: string
  try {
    phrase = Buffer.concat([
      decipher.update(Buffer.from(toBytes(v.ciphertext))),
      decipher.final()
    ]).toString('utf8')
  } catch {
    // GCM authenticates, so a wrong password and a tampered file both land
    // here. They are reported identically: telling an attacker which one they
    // got right is free information.
    throw new VaultError('wrong password, or the vault has been altered')
  }

  if (!isValidPhrase(phrase)) throw new VaultError('the vault did not contain a valid phrase')
  return phrase
}

function validate(value: unknown): Vault {
  const v = value as Vault
  if (!v || typeof v !== 'object') throw new VaultError('vault must be an object')
  if (v.version !== 1) throw new VaultError(`unsupported vault version: ${v.version}`)
  if (v.kdf !== 'scrypt') throw new VaultError(`unsupported kdf: ${v.kdf}`)
  if (v.cipher !== 'aes-256-gcm') throw new VaultError(`unsupported cipher: ${v.cipher}`)

  const p = v.kdfparams
  if (!p || typeof p.n !== 'number' || typeof p.r !== 'number' || typeof p.p !== 'number') {
    throw new VaultError('vault kdfparams are incomplete')
  }
  // Low parameters would decrypt instantly and protect nothing; absurd ones
  // would exhaust memory on a file anyone can hand you.
  if (p.n < 16_384 || p.n > 1 << 22) throw new VaultError(`scrypt N out of range: ${p.n}`)
  if (p.dklen !== 32) throw new VaultError(`unsupported dklen: ${p.dklen}`)

  return v
}

/**
 * The private key for one account of a phrase.
 *
 * Index 0 at `m/44'/60'/0'/0/0` is what every wallet calls "Account 1", so the
 * first address here is the first address anywhere else the phrase is restored.
 */
export function derivePrivateKey(phrase: string, index = 0): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new VaultError(`account index must be a non-negative integer, got ${index}`)
  }

  const clean = normalise(phrase)
  if (!isValidPhrase(clean)) throw new VaultError('that is not a valid recovery phrase')

  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(clean)).derive(`${ACCOUNT_PATH}/${index}`)
  if (!key.privateKey) throw new VaultError('derivation produced no private key')

  return toHex(key.privateKey)
}
