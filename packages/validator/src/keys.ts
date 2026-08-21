import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

/**
 * Validator keys, derived the way the deposit specification says to.
 *
 * This is not the wallet's key derivation with a different curve in it. A
 * validator signs with BLS12-381 over a tree defined by EIP-2333, addressed by
 * the paths in EIP-2334, and the deposit that activates it is signed under a
 * domain the beacon chain computes from its own genesis. Every one of those is
 * a place where "close enough" produces a key pair that looks perfectly valid,
 * signs perfectly valid signatures, and is rejected by the deposit contract —
 * or worse, accepted, after 500,000 LCAI has moved and cannot come back.
 *
 * So the derivation here is written against the specification's own words and
 * checked against the specification's own test vectors, in `keys.test.ts`.
 * Nothing in this file is a convenience wrapper around something else.
 */

const R = bls12_381.fields.Fr.ORDER

/** `IKM_to_lamport_SK`: 255 chunks of 32 bytes, as one 8160-byte expansion. */
function lamportSecrets(ikm: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, salt, new Uint8Array(0), 8160)
}

/**
 * `parent_SK_to_lamport_PK`.
 *
 * The one-time signature half of the tree: 255 secrets from the key, 255 more
 * from its bitwise complement, each hashed, the 510 digests concatenated and
 * hashed once more.
 */
function lamportPublicKey(parent: bigint, index: number): Uint8Array {
  const salt = new Uint8Array(4)
  new DataView(salt.buffer).setUint32(0, index, false)

  const ikm = toBytes32(parent)
  const notIkm = ikm.map((byte) => byte ^ 0xff)

  const first = lamportSecrets(ikm, salt)
  const second = lamportSecrets(notIkm, salt)

  const combined = new Uint8Array(510 * 32)
  for (let i = 0; i < 255; i++) {
    combined.set(sha256(first.subarray(i * 32, i * 32 + 32)), i * 32)
    combined.set(sha256(second.subarray(i * 32, i * 32 + 32)), (255 + i) * 32)
  }

  return sha256(combined)
}

/**
 * `HKDF_mod_r`.
 *
 * The salt is re-hashed and the whole thing retried while the result is zero —
 * which never happens in practice and is in the specification because a key of
 * zero is not a key. Written as the specification writes it rather than as the
 * one iteration it always takes.
 */
function hkdfModR(ikm: Uint8Array, keyInfo: Uint8Array = new Uint8Array(0)): bigint {
  let salt = new TextEncoder().encode('BLS-SIG-KEYGEN-SALT-')

  // The 48 that L is, appended to key_info as two big-endian bytes.
  const info = new Uint8Array(keyInfo.length + 2)
  info.set(keyInfo)
  info[keyInfo.length] = 0
  info[keyInfo.length + 1] = 48

  // IKM with the trailing zero byte the specification appends.
  const padded = new Uint8Array(ikm.length + 1)
  padded.set(ikm)

  for (;;) {
    salt = sha256(salt)
    const okm = hkdf(sha256, padded, salt, info, 48)
    const sk = bytesToBigInt(okm) % R
    if (sk !== 0n) return sk
  }
}

/** `derive_master_SK`. The seed must be at least 32 bytes; BIP-39's is 64. */
export function deriveMasterSK(seed: Uint8Array): bigint {
  if (seed.length < 32) {
    throw new Error(`the seed must be at least 32 bytes, got ${seed.length}`)
  }
  return hkdfModR(seed)
}

/** `derive_child_SK`. */
export function deriveChildSK(parent: bigint, index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`the index must be a uint32, got ${index}`)
  }
  return hkdfModR(lamportPublicKey(parent, index))
}

/**
 * A key at an EIP-2334 path, written as people write them: `m/12381/3600/0/0/0`.
 *
 * Only `m` and unhardened-looking numbers: every index in this tree is hardened
 * and the notation does not mark them, which is exactly the kind of detail that
 * makes a hand-rolled parser produce the wrong key silently. Anything that is
 * not `m` followed by integers is refused.
 */
export function deriveFromPath(seed: Uint8Array, path: string): bigint {
  const parts = path.trim().split('/')
  if (parts.shift() !== 'm') throw new Error(`a derivation path starts with "m", got ${path}`)

  let sk = deriveMasterSK(seed)
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`"${part}" is not an index, in ${path}`)
    sk = deriveChildSK(sk, Number(part))
  }
  return sk
}

/**
 * The EIP-2334 path of the signing key for validator `index`.
 *
 * `12381` is the curve, `3600` is the beacon chain, then the validator's own
 * number, then `0` for the withdrawal key and `0` again for the signing key
 * beneath it. The withdrawal key is deliberately not used here — see
 * `withdrawalCredentials`.
 */
export function signingPath(index: number): string {
  return `m/12381/3600/${index}/0/0`
}

/** The 32-byte big-endian form a secret key is stored and hashed as. */
export function toBytes32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32)
  let rest = value
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return bytes
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

/** The 48-byte compressed G1 public key for a secret key. */
export function publicKeyOf(sk: bigint): Uint8Array {
  return bls12_381.longSignatures.getPublicKey(toBytes32(sk)).toBytes()
}

/**
 * The domain separation tag the beacon chain signs under.
 *
 * Not the library's default, which ends `_NUL_`. The beacon chain uses the
 * proof-of-possession suite, `_POP_`, and the two differ in one word of a
 * string that is hashed into the message — so signing under the wrong one
 * produces a flawless signature that every beacon node rejects, and produces it
 * silently. This constant is the difference between a deposit that activates a
 * validator and 500,000 LCAI that goes nowhere.
 *
 * https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-bls-signature-05
 */
export const ETH_DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_'

/** The message, mapped onto G2 under the beacon chain's tag. */
function toG2(message: Uint8Array) {
  return bls12_381.longSignatures.hash(message, ETH_DST)
}

/** A 96-byte G2 signature over an already-computed signing root. */
export function sign(sk: bigint, signingRoot: Uint8Array): Uint8Array {
  return bls12_381.longSignatures.sign(toG2(signingRoot), toBytes32(sk)).toBytes()
}

export function verify(
  signature: Uint8Array,
  signingRoot: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return bls12_381.longSignatures.verify(signature, toG2(signingRoot), publicKey)
}

/**
 * A fresh 24-word phrase.
 *
 * 256 bits rather than the wallet's shorter phrase, because this one is the
 * only way back to a validator's signing key and there is no support desk that
 * can reissue it.
 */
export function generateValidatorPhrase(): string {
  return generateMnemonic(wordlist, 256)
}

/** The BIP-39 seed a phrase derives to. Refuses a phrase that is not one. */
export function seedFromPhrase(phrase: string, passphrase = ''): Uint8Array {
  const clean = phrase.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!validateMnemonic(clean, wordlist)) {
    throw new Error('that is not a valid recovery phrase')
  }
  return mnemonicToSeedSync(clean, passphrase)
}
