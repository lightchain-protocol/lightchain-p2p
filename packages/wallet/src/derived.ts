import '#globals'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { keccak256, toBytes } from '@lcai-p2p/chain'
import type { Account } from '@lcai-p2p/chain'

/**
 * Local data protected by the wallet rather than by file permissions.
 *
 * The application keeps things beside its storage that are secrets in their own
 * right: room encryption keys, transcripts. Leaving them in the clear makes the
 * weakest file in the directory the real security boundary, however carefully
 * everything else is encrypted.
 *
 * A key here is **derived, never stored**: a signature over a fixed sentence,
 * which is deterministic for one account and unobtainable without it. So the
 * data is protected by the password that opens the wallet, a locked wallet
 * cannot read it, and restoring a different phrase leaves it closed — which is
 * right, since it was never that identity's to read.
 *
 * No key derivation function here, deliberately. There is no password to
 * stretch: the input is already a secp256k1 signature, and the password that
 * guards it was stretched by scrypt when the vault was opened.
 */

export class DerivedKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DerivedKeyError'
  }
}

/**
 * A 32-byte key for one purpose.
 *
 * The purpose is part of what gets signed, so two kinds of data never share a
 * key. Reusing one across purposes means a flaw in how one is written exposes
 * the other, and nonce reuse across two files becomes a real possibility.
 */
export function deriveKey(account: Account, purpose: string): Uint8Array {
  if (purpose.trim() === '') throw new DerivedKeyError('a derived key needs a purpose')
  return keccak256(toBytes(account.signMessage(`Lightchain local data key v1: ${purpose}`)))
}

/** AES-256-GCM. Output is `nonce(12) || ciphertext || tag(16)`. */
export function sealData(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new DerivedKeyError(`key must be 32 bytes, got ${key.length}`)

  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
  return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]))
}

export function openData(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new DerivedKeyError(`key must be 32 bytes, got ${key.length}`)
  if (sealed.length < 12 + 16) throw new DerivedKeyError('sealed data is too short to be any')

  const decipher = createDecipheriv('aes-256-gcm', key, sealed.slice(0, 12))
  decipher.setAuthTag(Buffer.from(sealed.slice(-16)))

  try {
    return new Uint8Array(
      Buffer.concat([decipher.update(Buffer.from(sealed.slice(12, -16))), decipher.final()])
    )
  } catch {
    // GCM authenticates, so a wrong key and a tampered file land here alike.
    throw new DerivedKeyError('wrong key, or the data has been altered')
  }
}

/** The same, for the JSON these actually hold. */
export function sealJson(key: Uint8Array, value: unknown): Uint8Array {
  return sealData(key, new TextEncoder().encode(JSON.stringify(value)))
}

export function openJson<T>(key: Uint8Array, sealed: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(openData(key, sealed))) as T
}
