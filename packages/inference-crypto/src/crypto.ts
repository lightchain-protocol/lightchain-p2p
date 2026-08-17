// First, and for its side effect only: noble touches TextEncoder while its own
// module body evaluates, and Bare has no such global until this installs it.
import '#globals'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { p256 } from '@noble/curves/nist.js'

/**
 * The encryption used to talk to a worker.
 *
 * ECDH P-256 for key exchange, AES-256-GCM for the payload, and **no HKDF** —
 * the raw ECDH output is the AES key. That is not a choice made here: it is the
 * format the deployed Go workers already speak
 * (`lightchain-shared-pkg/crypto`), so it is fixed until every worker is
 * upgraded. Read `session_key.go` and `aes.go` before changing a byte of this.
 *
 * ## Why not sodium-native
 *
 * The rest of this repository does its cryptography with sodium, which cannot
 * help here at all. libsodium has no P-256 — it is X25519 — so matching the
 * workers means a NIST curve from somewhere else. Bare's own `bare-crypto`
 * exposes only Ed25519, HMAC, PBKDF2 and SHA through WebCrypto, and its
 * `deriveBits` accepts PBKDF2 alone. Hence `@noble/curves`, which is pure
 * JavaScript and therefore runs unchanged under Bare, Node and a browser.
 *
 * The symmetric half needs no such workaround: `crypto` resolves to
 * `bare-crypto` under Bare and to Node's built-in elsewhere, and both produce
 * identical AES-256-GCM bytes.
 *
 * ## Wire formats
 *
 * ```
 * encrypt:           nonce(12) || ciphertext || tag(16)
 * encryptSessionKey: ephemeralPublicKey(65) || nonce(12) || ciphertext || tag(16)
 * ```
 */

/** AES-256. */
export const KEY_BYTES = 32
/** GCM nonce, as Go's `gcm.NonceSize()`. */
export const NONCE_BYTES = 12
/** GCM authentication tag. */
export const TAG_BYTES = 16
/** An uncompressed P-256 point: `0x04 || X(32) || Y(32)`. */
export const PUBLIC_KEY_BYTES = 65
/** A P-256 scalar. */
export const SECRET_KEY_BYTES = 32
/** Session keys are AES-256 keys. */
export const SESSION_KEY_BYTES = 32

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

export interface KeyPair {
  readonly secretKey: Uint8Array
  readonly publicKey: Uint8Array
}

function check(value: Uint8Array, length: number, what: string): void {
  if (value.length !== length) {
    throw new CryptoError(`${what} must be ${length} bytes, got ${value.length}`)
  }
}

/** A random 32-byte session key. */
export function generateSessionKey(): Uint8Array {
  return new Uint8Array(randomBytes(SESSION_KEY_BYTES))
}

/** A P-256 key pair, with the public key uncompressed to match the workers. */
export function generateKeyPair(): KeyPair {
  const secretKey = p256.utils.randomSecretKey()
  return { secretKey, publicKey: p256.getPublicKey(secretKey, false) }
}

export function derivePublicKey(secretKey: Uint8Array): Uint8Array {
  check(secretKey, SECRET_KEY_BYTES, 'secret key')
  return p256.getPublicKey(secretKey, false)
}

/**
 * The ECDH shared secret, used directly as an AES-256 key.
 *
 * This is the x-coordinate alone, matching Go's `priv.ECDH(remotePub)` and
 * WebCrypto's `deriveBits(..., 256)`. noble returns a whole point, so the
 * leading format byte is dropped and the y-coordinate ignored.
 */
export function deriveSharedSecret(secretKey: Uint8Array, remotePublicKey: Uint8Array): Uint8Array {
  check(secretKey, SECRET_KEY_BYTES, 'secret key')
  check(remotePublicKey, PUBLIC_KEY_BYTES, 'public key')

  let point: Uint8Array
  try {
    point = p256.getSharedSecret(secretKey, remotePublicKey, false)
  } catch (err) {
    throw new CryptoError(`could not derive a shared secret: ${(err as Error).message}`)
  }
  return point.slice(1, 1 + KEY_BYTES)
}

/** AES-256-GCM with a fresh nonce. Output is `nonce || ciphertext || tag`. */
export function encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  check(key, KEY_BYTES, 'key')

  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])

  // Go appends the tag to the ciphertext; Node and Bare hand it over
  // separately, so it is concatenated here to produce the same bytes.
  return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]))
}

export function decrypt(key: Uint8Array, payload: Uint8Array): Uint8Array {
  check(key, KEY_BYTES, 'key')
  if (payload.length < NONCE_BYTES + TAG_BYTES) {
    throw new CryptoError('ciphertext too short')
  }

  const nonce = payload.subarray(0, NONCE_BYTES)
  const body = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)

  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)

  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]))
  } catch {
    // The tag failing is the whole point of an AEAD, and the underlying message
    // is unhelpful. Never report which part failed.
    throw new CryptoError('could not decrypt: wrong key or tampered ciphertext')
  }
}

/**
 * Wraps a session key for one recipient.
 *
 * A fresh ephemeral key pair per call, so the same session key sent to two
 * workers shares nothing between them.
 */
export function encryptSessionKey(sessionKey: Uint8Array, remotePublicKey: Uint8Array): Uint8Array {
  check(sessionKey, SESSION_KEY_BYTES, 'session key')

  const ephemeral = generateKeyPair()
  const shared = deriveSharedSecret(ephemeral.secretKey, remotePublicKey)
  const wrapped = encrypt(shared, sessionKey)

  const out = new Uint8Array(ephemeral.publicKey.length + wrapped.length)
  out.set(ephemeral.publicKey, 0)
  out.set(wrapped, ephemeral.publicKey.length)
  return out
}

export function decryptSessionKey(payload: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (payload.length < PUBLIC_KEY_BYTES) {
    throw new CryptoError(
      `encrypted session key too short: must be at least ${PUBLIC_KEY_BYTES} bytes`
    )
  }

  const ephemeralPublicKey = payload.subarray(0, PUBLIC_KEY_BYTES)
  const wrapped = payload.subarray(PUBLIC_KEY_BYTES)

  const shared = deriveSharedSecret(secretKey, ephemeralPublicKey)
  const sessionKey = decrypt(shared, wrapped)

  if (sessionKey.length !== SESSION_KEY_BYTES) {
    throw new CryptoError(
      `session key must be ${SESSION_KEY_BYTES} bytes, got ${sessionKey.length}`
    )
  }
  return sessionKey
}
