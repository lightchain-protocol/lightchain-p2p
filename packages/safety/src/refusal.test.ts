import { describe, expect, it } from 'vitest'
import {
  defaultPolicy,
  evaluate,
  isRefused,
  type RefusalPolicy,
  type RefusalRecord
} from './refusal.js'

const NOW = 1_760_000_000_000

function record(over: Partial<RefusalRecord> = {}): RefusalRecord {
  return { category: 'csam', createdAt: NOW - 1000, ...over }
}

describe('evaluate', () => {
  it('refuses a live entry in an honoured category', () => {
    expect(evaluate(record(), defaultPolicy(), NOW)).toEqual({
      refused: true,
      category: 'csam'
    })
  })

  it('does not refuse when no entry exists', () => {
    expect(evaluate(undefined, defaultPolicy(), NOW)).toEqual({
      refused: false,
      reason: 'no-record'
    })
  })

  it('does not refuse a revoked entry, so a mistake can be corrected', () => {
    const outcome = evaluate(record({ revoked: true }), defaultPolicy(), NOW)
    expect(outcome).toEqual({ refused: false, reason: 'revoked' })
  })

  describe('emergency entries lapse unless ratified', () => {
    it('refuses while still inside the window', () => {
      const entry = record({ expiresAt: NOW + 1 })
      expect(isRefused(entry, defaultPolicy(), NOW)).toBe(true)
    })

    it('stops refusing the instant it expires', () => {
      const entry = record({ expiresAt: NOW })
      expect(evaluate(entry, defaultPolicy(), NOW)).toEqual({
        refused: false,
        reason: 'expired'
      })
    })

    it('fails safe rather than persisting when nobody acts', () => {
      const seventyTwoHours = 72 * 60 * 60 * 1000
      const entry = record({ expiresAt: NOW + seventyTwoHours })
      expect(isRefused(entry, defaultPolicy(), NOW + seventyTwoHours + 1)).toBe(false)
    })
  })

  describe('category scope', () => {
    it('honours both universal categories by default', () => {
      expect(isRefused(record({ category: 'csam' }), defaultPolicy(), NOW)).toBe(true)
      expect(isRefused(record({ category: 'illegal-per-se' }), defaultPolicy(), NOW)).toBe(true)
    })

    it('ignores a category the subscriber has not opted into', () => {
      const outcome = evaluate(record({ category: 'spam' }), defaultPolicy(), NOW)
      expect(outcome).toEqual({ refused: false, reason: 'not-honoured' })
    })

    it('honours an extended category only when explicitly opted in', () => {
      const policy: RefusalPolicy = { honour: new Set(['csam', 'spam']) }
      expect(isRefused(record({ category: 'spam' }), policy, NOW)).toBe(true)
    })
  })

  it('checks revocation before expiry, so a revoked emergency entry reads as revoked', () => {
    const entry = record({ revoked: true, expiresAt: NOW - 1 })
    expect(evaluate(entry, defaultPolicy(), NOW)).toEqual({
      refused: false,
      reason: 'revoked'
    })
  })
})
