import '#globals'
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto'
import { scrypt } from '@noble/hashes/scrypt.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak256, toAddress, toBytes, toHex } from '@lcai-p2p/chain'

/**
 * Web3 Secret Storage, the keystore format every Ethereum tool reads.
 *
 * ## Why this format and not something more modern
 *
 * AES-128-CTR with a keccak MAC is not what anyone would choose today; an AEAD
 * like AES-256-GCM is the obvious modern answer. This uses V3 anyway, for one
 * reason that outweighs the primitives: **the key is never trapped here.** A
 * wallet that invents its own format holds the user hostage to it. A V3
 * keystore opens in Foundry, geth, MetaMask and everything else, and
 * `apps/supervisor` already deals in exactly these files, so it is one concept
 * across the product rather than two.
 *
 * The construction is sound: encrypt-then-MAC over the ciphertext, with the MAC
 * key taken from a different half of the derived key than the cipher key. The
 * tests verify against Foundry in both directions.
 *
 * ## Where the security actually is
 *
 * Not in the cipher. A stolen keystore is attacked by guessing the password, so
 * what matters is the cost per guess — scrypt at N=262144 forces an attacker to
 * spend 256 MiB and about half a second for every attempt, on hardware no
 * better than ours.
 */

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeystoreError'
  }
}

/**
 * geth's "standard" parameters, and the reason this is slow on purpose.
 *
 * Measured at roughly 0.5 seconds and 256 MiB under both Node and Bare, which
 * is a fine price once at unlock and a brutal one multiplied by a dictionary.
 * geth's "light" preset uses N=4096 — sixty times cheaper to attack — and is
 * not worth the third of a second it saves.
 */
export const SCRYPT_N = 262_144
export const SCRYPT_R = 8
export const SCRYPT_P = 1
const DK_LEN = 32

export interface KeystoreV3 {
  readonly version: 3
  readonly id: string
  /**
   * Lowercase, without `0x`. **Optional in the format** — Foundry writes
   * keystores with no address at all, so a reader cannot rely on it.
   */
  readonly address?: string
  readonly crypto: {
    readonly cipher: 'aes-128-ctr'
    readonly cipherparams: { readonly iv: string }
    readonly ciphertext: string
    readonly kdf: 'scrypt'
    readonly kdfparams: {
      readonly dklen: number
      readonly n: number
      readonly p: number
      readonly r: number
      readonly salt: string
    }
    readonly mac: string
  }
}

const bare = (hex: string) => (hex.startsWith('0x') ? hex.slice(2) : hex)

function derive(
  password: string,
  salt: Uint8Array,
  params: { N: number; r: number; p: number; dkLen: number }
) {
  // The password is normalised the way the spec expects: UTF-8 bytes, no
  // trimming. A password with a trailing space is a different password.
  return scrypt(new TextEncoder().encode(password), salt, params)
}

function macOf(derivedKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  // The second half of the derived key, so the MAC key and the cipher key are
  // independent. Using the same bytes for both is the classic mistake here.
  const out = new Uint8Array(16 + ciphertext.length)
  out.set(derivedKey.slice(16, 32), 0)
  out.set(ciphertext, 16)
  return keccak256(out)
}

/** A v4 UUID, as the format's `id` field. Cosmetic; nothing depends on it. */
function uuid(): string {
  const b = randomBytes(16)
  b[6] = ((b[6] as number) & 0x0f) | 0x40
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const hex = toHex(new Uint8Array(b)).slice(2)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function encrypt(privateKey: string, password: string): KeystoreV3 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new KeystoreError('private key must be 32 bytes of hex')
  }
  if (password.length === 0) {
    // An empty password produces a file that looks encrypted and is not.
    throw new KeystoreError('a password is required')
  }

  const salt = new Uint8Array(randomBytes(32))
  const iv = new Uint8Array(randomBytes(16))
  const derivedKey = derive(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: DK_LEN
  })

  const cipher = createCipheriv('aes-128-ctr', derivedKey.slice(0, 16), iv)
  const ciphertext = new Uint8Array(
    Buffer.concat([cipher.update(Buffer.from(toBytes(privateKey))), cipher.final()])
  )

  const secp256k1PublicKey = publicKeyOf(privateKey)

  return {
    version: 3,
    id: uuid(),
    address: bare(toAddress(secp256k1PublicKey)).toLowerCase(),
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: bare(toHex(iv)) },
      ciphertext: bare(toHex(ciphertext)),
      kdf: 'scrypt',
      kdfparams: {
        dklen: DK_LEN,
        n: SCRYPT_N,
        p: SCRYPT_P,
        r: SCRYPT_R,
        salt: bare(toHex(salt))
      },
      mac: bare(toHex(macOf(derivedKey, ciphertext)))
    }
  }
}

/**
 * Recovers the private key, or refuses.
 *
 * The MAC is checked before the plaintext is used and compared in constant
 * time. A wrong password and a tampered file are reported identically on
 * purpose — distinguishing them tells an attacker which half they got right.
 */
export function decrypt(keystore: unknown, password: string): string {
  const parsed = validate(keystore)
  const { kdfparams, cipherparams } = parsed.crypto

  const derivedKey = derive(password, toBytes(`0x${kdfparams.salt}`), {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    dkLen: kdfparams.dklen
  })

  const ciphertext = toBytes(`0x${parsed.crypto.ciphertext}`)
  const expected = macOf(derivedKey, ciphertext)
  const actual = toBytes(`0x${parsed.crypto.mac}`)

  if (
    expected.length !== actual.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  ) {
    throw new KeystoreError('wrong password, or the keystore has been altered')
  }

  const decipher = createDecipheriv(
    'aes-128-ctr',
    derivedKey.slice(0, 16),
    toBytes(`0x${cipherparams.iv}`)
  )
  const privateKey = toHex(
    new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]))
  )

  // The MAC already proves the password; this proves the file is internally
  // consistent, catching a keystore whose stated address is not its key's.
  if (parsed.address && bare(toAddress(publicKeyOf(privateKey))).toLowerCase() !== parsed.address) {
    throw new KeystoreError('the keystore address does not match the key it contains')
  }

  return privateKey
}

/**
 * The address a keystore claims, without needing the password.
 *
 * Null when the file does not say. The field is optional in the format and
 * Foundry omits it, so the only way to learn the address of one of its
 * keystores is to decrypt it.
 */
export function addressOf(keystore: unknown): string | null {
  const address = validate(keystore).address
  return typeof address === 'string' && address.length > 0 ? `0x${address}` : null
}

function validate(value: unknown): KeystoreV3 {
  const k = value as KeystoreV3
  if (!k || typeof k !== 'object') throw new KeystoreError('keystore must be an object')
  if (k.version !== 3) throw new KeystoreError(`unsupported keystore version: ${k.version}`)

  const c = k.crypto
  if (!c || typeof c !== 'object') throw new KeystoreError('keystore has no crypto section')
  if (c.cipher !== 'aes-128-ctr') throw new KeystoreError(`unsupported cipher: ${c.cipher}`)
  if (c.kdf !== 'scrypt') {
    // pbkdf2 keystores exist and are readable; supporting them without a
    // reason to is more code paths handling secrets.
    throw new KeystoreError(`unsupported kdf: ${c.kdf}. Only scrypt is read.`)
  }

  const p = c.kdfparams
  if (!p || typeof p.n !== 'number' || typeof p.r !== 'number' || typeof p.p !== 'number') {
    throw new KeystoreError('keystore kdfparams are incomplete')
  }
  // A file claiming N=2 would decrypt instantly and offer no protection; a
  // hostile one claiming N=2^30 would exhaust memory on open.
  if (p.n < 1024 || p.n > 1 << 22) throw new KeystoreError(`scrypt N out of range: ${p.n}`)
  if (p.dklen !== 32) throw new KeystoreError(`unsupported dklen: ${p.dklen}`)

  return k
}

function publicKeyOf(privateKey: string): Uint8Array {
  return secp256k1.getPublicKey(toBytes(privateKey), false)
}
