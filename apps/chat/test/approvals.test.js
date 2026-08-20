import { describe, expect, it } from 'vitest'
import { approvalSequence } from '../workers/handlers/bridge.mjs'

/**
 * Which approvals are sent to take an allowance to exactly the amount needed.
 *
 * USDT on Ethereum — a curated swap input — rejects an `approve` that moves
 * one non-zero allowance straight to another. That residue is exactly what a
 * swap or transfer leaves when it reverts after its approval landed, and the
 * next exact approval reverting on it is the failure this exists to prevent.
 */

const AMOUNT = 1_000_000n

describe('the approval sequence', () => {
  it('is one exact approval when nothing is allowed yet', () => {
    expect(approvalSequence(0n, AMOUNT)).toEqual([AMOUNT])
  })

  it('is nothing when the allowance is already exactly right', () => {
    expect(approvalSequence(AMOUNT, AMOUNT)).toEqual([])
  })

  it('passes through zero when a smaller stale allowance remains', () => {
    // The residue case: a previous swap approved 500 and then reverted, so the
    // allowance stands at 500 and a direct approve(1000) would revert on USDT.
    expect(approvalSequence(500n, AMOUNT)).toEqual([0n, AMOUNT])
  })

  it('passes through zero when a larger stale allowance remains', () => {
    // Larger covers the spend, but the policy here is exact approvals — so the
    // stale grant is reset rather than left standing above what is needed.
    expect(approvalSequence(AMOUNT * 2n, AMOUNT)).toEqual([0n, AMOUNT])
  })

  it('resets even a one-wei residue rather than approving over it', () => {
    expect(approvalSequence(1n, AMOUNT)).toEqual([0n, AMOUNT])
  })

  it('never produces more than the reset and the grant', () => {
    for (const current of [0n, 1n, 500n, AMOUNT, AMOUNT * 2n, 2n ** 256n - 1n]) {
      const steps = approvalSequence(current, AMOUNT)
      expect(steps.length).toBeLessThanOrEqual(2)
      expect(steps.at(-1) ?? current).toBe(AMOUNT)
      if (steps.length === 2) expect(steps[0]).toBe(0n)
    }
  })
})
