import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak256 } from './abi.js'
import { concat, toBytes, toChecksumAddress, toHex } from './hex.js'
import * as rlp from './rlp.js'

/**
 * Keys, addresses and transaction signing.
 *
 * secp256k1 here, which is Ethereum's curve and **not** the P-256 the workers
 * use for prompt encryption in [`@lcai-p2p/inference-crypto`](../inference-crypto).
 * Two curves, two purposes; mixing them up produces keys that look right and
 * work nowhere.
 *
 * Nothing in this file logs, and nothing returns a private key. An `Account`
 * closes over its key and exposes only what it can do with it.
 */

export class AccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountError'
  }
}

/** An EIP-1559 transaction. Legacy and access lists are deliberately not supported. */
export interface Transaction {
  readonly chainId: number
  readonly nonce: bigint
  readonly to: string
  readonly value: bigint
  readonly data: string
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

export interface Account {
  /** EIP-55 checksummed. */
  readonly address: string
  signTransaction(tx: Transaction): string
  /** EIP-191 personal_sign, for proving control of the address off chain. */
  signMessage(message: string): string
}

/**
 * EIP-191 over a 32-byte digest.
 *
 * The `personal_sign` prefix, but applied to a hash rather than to text —
 * `"\x19Ethereum Signed Message:\n32"` with the literal string `32`, because
 * the length is of the bytes being signed and those bytes are a digest.
 * Contracts do exactly this before `ecrecover`, so getting it wrong recovers a
 * plausible address that matches nothing.
 */
export function hashDigestForSigning(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) {
    throw new AccountError(`expected a 32-byte digest, got ${digest.length}`)
  }
  return keccak256(concat(new TextEncoder().encode('\x19Ethereum Signed Message:\n32'), digest))
}

/**
 * EIP-191 over text, which is what {@link Account.signMessage} signs.
 *
 * The length in the prefix is the **byte** length, not the character count, so
 * a message with any non-ASCII in it hashes differently than a naive
 * implementation expects. Recovering from a `signMessage` signature means
 * hashing with this and not with {@link hashDigestForSigning}: the two differ
 * whenever the text is not exactly 32 bytes long, which is nearly always.
 */
export function hashMessageForSigning(message: string): Uint8Array {
  const body = new TextEncoder().encode(message)
  return keccak256(
    concat(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`), body)
  )
}

/**
 * Who signed something.
 *
 * The recovery byte is 27 or 28 by Ethereum convention and 0 or 1 as
 * secp256k1 actually defines it. Both appear in the wild — the Lightchain
 * workers emit 0/1 while contracts expect 27/28 — so both are accepted rather
 * than making the caller know which they have.
 */
export function recoverAddress(digest: Uint8Array, signature: string | Uint8Array): string {
  const bytes = typeof signature === 'string' ? toBytes(signature) : signature
  if (bytes.length !== 65) {
    throw new AccountError(`a signature is 65 bytes, got ${bytes.length}`)
  }

  const raw = bytes[64] as number
  const yParity = raw >= 27 ? raw - 27 : raw
  if (yParity !== 0 && yParity !== 1) {
    throw new AccountError(`recovery byte must be 0, 1, 27 or 28, got ${raw}`)
  }

  try {
    // noble wants `recovery || r || s`, the order it signs in, and hands back a
    // compressed point — while an address is the hash of the uncompressed one.
    const recovered = secp256k1.recoverPublicKey(
      concat(new Uint8Array([yParity]), bytes.slice(0, 64)),
      digest,
      { prehash: false }
    )
    return toAddress(secp256k1.Point.fromBytes(recovered).toBytes(false))
  } catch (err) {
    throw new AccountError(`could not recover a signer: ${(err as Error).message}`)
  }
}

/** The address a public key belongs to: last 20 bytes of the hash of the point. */
export function toAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new AccountError('expected a 65-byte uncompressed public key')
  }
  // The leading 0x04 is a format marker and is not part of the hashed point.
  const hashed = keccak256(publicKey.slice(1))
  return toChecksumAddress(toHex(hashed.slice(12)), keccak256)
}

function serialise(tx: Transaction, signature?: { yParity: number; r: bigint; s: bigint }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
    throw new AccountError(`transaction "to" must be a 20-byte address, got ${tx.to}`)
  }

  const fields: rlp.RlpInput[] = [
    rlp.number(BigInt(tx.chainId)),
    rlp.number(tx.nonce),
    rlp.number(tx.maxPriorityFeePerGas),
    rlp.number(tx.maxFeePerGas),
    rlp.number(tx.gas),
    toBytes(tx.to),
    rlp.number(tx.value),
    toBytes(tx.data),
    // Access list, empty. Present because its position is part of the format.
    []
  ]

  if (signature) {
    fields.push(
      rlp.number(BigInt(signature.yParity)),
      rlp.number(signature.r),
      rlp.number(signature.s)
    )
  }

  // 0x02 marks EIP-1559. It is a prefix, not part of the RLP payload.
  return concat(Uint8Array.of(0x02), rlp.encode(fields))
}

/**
 * An account from a raw private key.
 *
 * The key is read once and kept in a closure. It is never stored on the
 * returned object, so nothing that inspects, serialises or logs an `Account`
 * can reach it.
 */
export function fromPrivateKey(privateKey: string): Account {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new AccountError('private key must be 32 bytes of hex')
  }

  const key = toBytes(privateKey)
  if (!secp256k1.utils.isValidSecretKey(key)) {
    throw new AccountError('private key is not a valid secp256k1 scalar')
  }

  const address = toAddress(secp256k1.getPublicKey(key, false))

  function sign(digest: Uint8Array): { yParity: number; r: bigint; s: bigint } {
    // `recovery || r || s`, recovery first. Reading it from the other end gives
    // the tail of s, which looks like a plausible v and is not one.
    const signature = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' })
    return {
      yParity: signature[0] as number,
      r: BigInt(toHex(signature.slice(1, 33))),
      s: BigInt(toHex(signature.slice(33, 65)))
    }
  }

  return {
    address,

    signTransaction(tx) {
      if (!Number.isInteger(tx.chainId) || tx.chainId <= 0) {
        // A wrong or missing chain id is what makes a signed transaction
        // replayable on another chain.
        throw new AccountError(`chainId must be a positive integer, got ${tx.chainId}`)
      }
      return toHex(serialise(tx, sign(keccak256(serialise(tx)))))
    },

    signMessage(message) {
      const body = new TextEncoder().encode(message)
      const prefixed = concat(
        new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`),
        body
      )
      const { yParity, r, s } = sign(keccak256(prefixed))
      // Serialised as r || s || v, with v offset by 27 — the historical
      // encoding every verifier expects, and the opposite order to noble's.
      return toHex(
        concat(
          toBytes(`0x${r.toString(16).padStart(64, '0')}`),
          toBytes(`0x${s.toString(16).padStart(64, '0')}`),
          Uint8Array.of(yParity + 27)
        )
      )
    }
  }
}
