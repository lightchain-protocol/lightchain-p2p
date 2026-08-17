/**
 * How a model is referred to, on chain and between peers.
 *
 * The proposal describes a model as "addressed by a 32-byte key, self-certifying,
 * where the identifier is the retrieval address and the verification root
 * simultaneously". That is true of the drive but **not sufficient to identify
 * content**, and the difference matters enough to encode in the type.
 *
 * A Hyperdrive key names an append-only history, not a snapshot. Whoever holds
 * the drive's secret key can append at any time, and every reader following the
 * key alone will silently move to the new tip. If a job is priced and verified
 * against a bare key, the publisher can change what that model *is* after the
 * fact, and nothing in the retrieval path would notice.
 *
 * So a reference is always a key *and* a version. Both fields are required.
 */

/** Length of a Hyperdrive public key in bytes. */
export const KEY_BYTES = 32

const HEX_KEY = /^[0-9a-f]{64}$/

export interface ModelRef {
  /** Hyperdrive public key, lowercase hex, 64 characters. */
  readonly key: string
  /**
   * Hyperdrive version pinning the content. Always at least 1: Hyperbee reports
   * `Math.max(1, core.length)`, so version 0 never identifies real content.
   */
  readonly version: number
}

export class ModelRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelRefError'
  }
}

/** Canonical string form: `<64-hex>@<version>`. */
export function formatModelRef(ref: ModelRef): string {
  assertModelRef(ref)
  return `${ref.key}@${ref.version}`
}

/** Parses the canonical string form, rejecting anything ambiguous. */
export function parseModelRef(value: string): ModelRef {
  const at = value.lastIndexOf('@')
  if (at === -1) {
    throw new ModelRefError(
      `model reference must be "<key>@<version>", got "${value}". A bare key does not identify content.`
    )
  }

  const key = value.slice(0, at)
  const versionText = value.slice(at + 1)

  // Reject "1e3", " 12", "12.0" and similar: Number() accepts far more than we
  // want, and a misparsed version silently points at the wrong content.
  if (!/^\d+$/.test(versionText)) {
    throw new ModelRefError(`version must be a plain integer, got "${versionText}"`)
  }

  return assertModelRef({ key, version: Number(versionText) })
}

/** Validates a reference, returning it so this can be used inline. */
export function assertModelRef(ref: ModelRef): ModelRef {
  if (!HEX_KEY.test(ref.key)) {
    throw new ModelRefError(
      `key must be ${KEY_BYTES} bytes as lowercase hex (64 characters), got "${ref.key}"`
    )
  }
  if (!Number.isSafeInteger(ref.version) || ref.version < 1) {
    throw new ModelRefError(`version must be an integer of at least 1, got ${ref.version}`)
  }
  return ref
}

/** True when both references point at exactly the same content. */
export function modelRefEquals(a: ModelRef, b: ModelRef): boolean {
  return a.key === b.key && a.version === b.version
}
