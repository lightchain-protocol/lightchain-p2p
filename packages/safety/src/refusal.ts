/**
 * The refusal decision.
 *
 * Deliberately pure and free of any network or storage dependency: whether a
 * piece of content is refused is the most consequential judgement this codebase
 * makes, and it should be readable and exhaustively testable on its own.
 *
 * Transport (subscribing to the published Hypercore) lives elsewhere.
 */

/** Categories every subscriber is expected to honour. */
export const UNIVERSAL_CATEGORIES = ['csam', 'illegal-per-se'] as const

export type UniversalCategory = (typeof UNIVERSAL_CATEGORIES)[number]

/** A category may be one of the universal ones, or an opt-in extension. */
export type RefusalCategory = UniversalCategory | (string & {})

/**
 * One entry in the refusal list.
 *
 * Carries no description of the material and no hash of it, so that the
 * published list can never be mined to find what it protects against.
 */
export interface RefusalRecord {
  /** Narrow, published category. Subscribers choose which to honour. */
  readonly category: RefusalCategory
  /** Unix milliseconds. */
  readonly createdAt: number
  /**
   * Set only on emergency single-signer entries, which lapse unless a quorum
   * ratifies them. Absent means the entry does not expire.
   */
  readonly expiresAt?: number
  /** Opaque reference to the case file. Never a description. */
  readonly caseRef?: string
  /** Superseded by a later entry. The original stays visible forever. */
  readonly revoked?: boolean
}

export interface RefusalPolicy {
  /** Categories this participant honours. */
  readonly honour: ReadonlySet<RefusalCategory>
}

export type RefusalOutcome =
  | {
      readonly refused: false
      readonly reason: 'no-record' | 'revoked' | 'expired' | 'not-honoured'
    }
  | { readonly refused: true; readonly category: RefusalCategory }

/**
 * Decides whether a record refuses the content, and says why when it does not.
 *
 * The `reason` on a negative result matters: an operator debugging why
 * something is still being served needs to distinguish "no entry exists" from
 * "the entry lapsed" from "we do not honour that category".
 */
export function evaluate(
  record: RefusalRecord | undefined,
  policy: RefusalPolicy,
  now: number
): RefusalOutcome {
  if (!record) return { refused: false, reason: 'no-record' }
  if (record.revoked) return { refused: false, reason: 'revoked' }
  if (record.expiresAt !== undefined && record.expiresAt <= now) {
    return { refused: false, reason: 'expired' }
  }
  if (!policy.honour.has(record.category)) {
    return { refused: false, reason: 'not-honoured' }
  }
  return { refused: true, category: record.category }
}

/** Convenience wrapper for call sites that only need the boolean. */
export function isRefused(
  record: RefusalRecord | undefined,
  policy: RefusalPolicy,
  now: number = Date.now()
): boolean {
  return evaluate(record, policy, now).refused
}

/** The default policy: honour exactly the universal categories, nothing wider. */
export function defaultPolicy(): RefusalPolicy {
  return { honour: new Set<RefusalCategory>(UNIVERSAL_CATEGORIES) }
}
