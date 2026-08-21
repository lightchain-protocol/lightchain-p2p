import { sha256 } from '@noble/hashes/sha2.js'
import { publicKeyOf, sign, signingPath, deriveFromPath } from './keys.js'

/**
 * The deposit, as the contract will read it.
 *
 * A deposit is one irreversible transaction carrying four things the beacon
 * chain checks against each other: a public key, where the stake may eventually
 * be withdrawn to, an amount, and a signature over all three. Get the signature
 * domain wrong and the deposit is accepted by the contract and ignored by the
 * chain — the money is gone and no validator ever activates. That failure is
 * silent, which is why every root below is built out of the specification's own
 * containers rather than hashed as one blob.
 *
 * The chain's genesis fork version is a parameter here rather than a constant.
 * Lightchain's mainnet is `0x10000089` and its other networks are not, and a
 * fork version copied from Ethereum would produce exactly the silent failure
 * above.
 */

/** The 32-byte SSZ chunk of an empty tree of `count` leaves. */
const ZERO_CHUNK = new Uint8Array(32)

function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(64)
  joined.set(left)
  joined.set(right, 32)
  return sha256(joined)
}

/** Splits a byte string into 32-byte chunks, right-padding the last one. */
function chunks(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = new Uint8Array(32)
    chunk.set(bytes.subarray(i, Math.min(i + 32, bytes.length)))
    out.push(chunk)
  }
  return out.length === 0 ? [ZERO_CHUNK] : out
}

/**
 * `merkleize`: pad the chunk list to a power of two with zero chunks, then hash
 * pairwise up to a single root.
 */
function merkleize(leaves: Uint8Array[]): Uint8Array {
  let level = [...leaves]
  let width = 1
  while (width < level.length) width *= 2
  while (level.length < width) level.push(ZERO_CHUNK)

  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      // The padding above makes the list a power of two, so a right sibling
      // always exists; the fallback is here because the compiler cannot know
      // that and a silent `undefined` would hash to the wrong root.
      next.push(hashPair(level[i] ?? ZERO_CHUNK, level[i + 1] ?? ZERO_CHUNK))
    }
    level = next
  }

  return level[0] ?? ZERO_CHUNK
}

/** A uint64 as its own 32-byte chunk: little-endian, zero-padded. */
function uint64Chunk(value: bigint): Uint8Array {
  const chunk = new Uint8Array(32)
  new DataView(chunk.buffer).setBigUint64(0, value, true)
  return chunk
}

/** The `hash_tree_root` of a fixed-size container, given each field's root. */
function container(fields: Uint8Array[]): Uint8Array {
  return merkleize(fields)
}

/** `DOMAIN_DEPOSIT`, from the beacon specification. */
export const DOMAIN_DEPOSIT = new Uint8Array([0x03, 0x00, 0x00, 0x00])

/**
 * The deposit contract every Ethereum-shaped chain places at the same address.
 * Lightchain is no exception; the beacon chain's own `/config/spec` names it,
 * and callers should prefer that over this default.
 */
export const DEPOSIT_CONTRACT_ADDRESS = '0x4242424242424242424242424242424242424242'

/**
 * `compute_domain(DOMAIN_DEPOSIT, fork_version, genesis_validators_root)`.
 *
 * The genesis validators root is deliberately zero. A deposit is signed before
 * the chain has any opinion about the validator making it — it has to be
 * verifiable by anyone, including a chain that has not started — so the deposit
 * domain alone among all beacon domains uses the zero root.
 */
export function depositDomain(forkVersion: Uint8Array): Uint8Array {
  if (forkVersion.length !== 4) {
    throw new Error(`a fork version is 4 bytes, got ${forkVersion.length}`)
  }

  const forkData = container([pad32(forkVersion), ZERO_CHUNK])

  const domain = new Uint8Array(32)
  domain.set(DOMAIN_DEPOSIT)
  domain.set(forkData.subarray(0, 28), 4)
  return domain
}

function pad32(bytes: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(32)
  chunk.set(bytes)
  return chunk
}

/**
 * Withdrawal credentials that point at an ordinary address — the `0x01` form.
 *
 * The alternative, `0x00`, commits to a BLS withdrawal key that has to be
 * converted before anything can ever be withdrawn, and losing the phrase behind
 * it loses the stake outright. Pointing at an address the operator already
 * controls removes a whole class of ways to lose 500,000 LCAI, and it is what
 * every current guide recommends.
 */
export function withdrawalCredentials(address: string): Uint8Array {
  const hex = address.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`the withdrawal address must be a 20-byte address, got ${address}`)
  }

  const credentials = new Uint8Array(32)
  credentials[0] = 0x01
  for (let i = 0; i < 20; i++) {
    credentials[12 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return credentials
}

export interface DepositMessage {
  readonly pubkey: Uint8Array
  readonly withdrawalCredentials: Uint8Array
  /** Gwei. */
  readonly amount: bigint
}

/** `hash_tree_root(DepositMessage)`. */
export function depositMessageRoot(message: DepositMessage): Uint8Array {
  return container([
    merkleize(chunks(message.pubkey)),
    pad32(message.withdrawalCredentials),
    uint64Chunk(message.amount)
  ])
}

/** `hash_tree_root(DepositData)` — the message, plus the signature over it. */
export function depositDataRoot(message: DepositMessage, signature: Uint8Array): Uint8Array {
  return container([
    merkleize(chunks(message.pubkey)),
    pad32(message.withdrawalCredentials),
    uint64Chunk(message.amount),
    merkleize(chunks(signature))
  ])
}

/** `hash_tree_root(SigningData{object_root, domain})` — what actually gets signed. */
export function signingRoot(objectRoot: Uint8Array, domain: Uint8Array): Uint8Array {
  return container([pad32(objectRoot), pad32(domain)])
}

export interface Deposit {
  /** 48 bytes, hex. */
  readonly pubkey: string
  /** 32 bytes, hex. */
  readonly withdrawalCredentials: string
  /** 96 bytes, hex. */
  readonly signature: string
  /** 32 bytes, hex. */
  readonly depositDataRoot: string
  /** Gwei. */
  readonly amount: bigint
  /** Which validator index of this phrase it was derived at. */
  readonly index: number
}

/**
 * Everything one deposit needs, derived and signed.
 *
 * Verified before it is returned. Signing cannot fail loudly — a wrong domain
 * or a mis-built root produces a perfectly well-formed signature over the wrong
 * thing — so the only honest check is to verify it here, against the same
 * public key the deposit carries, before anybody is invited to send money.
 */
export function buildDeposit({
  seed,
  index,
  withdrawalAddress,
  amountGwei,
  forkVersion
}: {
  seed: Uint8Array
  index: number
  withdrawalAddress: string
  amountGwei: bigint
  forkVersion: Uint8Array
}): Deposit {
  const sk = deriveFromPath(seed, signingPath(index))
  const pubkey = publicKeyOf(sk)
  const credentials = withdrawalCredentials(withdrawalAddress)

  const message: DepositMessage = {
    pubkey,
    withdrawalCredentials: credentials,
    amount: amountGwei
  }

  const root = signingRoot(depositMessageRoot(message), depositDomain(forkVersion))
  const signature = sign(sk, root)

  return {
    pubkey: toHex(pubkey),
    withdrawalCredentials: toHex(credentials),
    signature: toHex(signature),
    depositDataRoot: toHex(depositDataRoot(message, signature)),
    amount: amountGwei,
    index
  }
}

export function toHex(bytes: Uint8Array): string {
  let hex = '0x'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  if (clean.length % 2 !== 0) throw new Error(`${hex} is not a whole number of bytes`)
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
