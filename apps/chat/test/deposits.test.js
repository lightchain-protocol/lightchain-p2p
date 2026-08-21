import { describe, expect, it } from 'vitest'
import { DepositTracker } from '../workers/deposits.mjs'

/**
 * When "money arrived" is said, and when it is not.
 *
 * The tracker compares each read of a balance against the highest value ever
 * seen for it — not against the previous read — and that one choice is most of
 * the feature: it is what keeps a launch quiet, a spend from ringing, and your
 * own money coming back from being announced as news.
 */

const held = (balance, over = {}) => ({
  chainId: 9200,
  chainName: 'Lightchain',
  kind: 'native',
  address: null,
  symbol: 'LCAI',
  decimals: 18,
  balance,
  ...over
})

const LCAI = (n) => (BigInt(n) * 10n ** 18n).toString()

describe('deposit detection', () => {
  it('never rings on the first read: launch is the baseline', () => {
    const tracker = new DepositTracker()
    expect(tracker.observe([held(LCAI(40))])).toEqual([])
  })

  it('rings once when a balance rises, with the excess as the amount', () => {
    const tracker = new DepositTracker()
    tracker.observe([held(LCAI(40))])

    const deposits = tracker.observe([held(LCAI(41))])
    expect(deposits).toHaveLength(1)
    expect(deposits[0].amountWei).toBe(LCAI(1))
    expect(deposits[0].symbol).toBe('LCAI')
    expect(deposits[0].chainName).toBe('Lightchain')

    // And not again for the same balance, however often it is read.
    expect(tracker.observe([held(LCAI(41))])).toEqual([])
    expect(tracker.observe([held(LCAI(41))])).toEqual([])
  })

  it('does not ring on a decrease, nor on a recovery to a value already seen', () => {
    const tracker = new DepositTracker()
    tracker.observe([held(LCAI(40))])

    // A rise rings once and moves the peak…
    expect(tracker.observe([held(LCAI(50))])).toHaveLength(1)

    // …a spend does not…
    expect(tracker.observe([held(LCAI(20))])).toEqual([])

    // …and coming back to where the peak already was is not news either. This
    // is the round trip: fund something and withdraw it, or send 5 out and
    // receive 5 back, and nothing chimes.
    expect(tracker.observe([held(LCAI(50))])).toEqual([])

    // Only above the peak is a deposit, and only the excess above it counts.
    const deposits = tracker.observe([held(LCAI(52))])
    expect(deposits).toHaveLength(1)
    expect(deposits[0].amountWei).toBe(LCAI(2))
  })

  it('tracks each asset on each chain apart', () => {
    const tracker = new DepositTracker()
    const token = (balance) =>
      held(balance, {
        kind: 'token',
        address: '0x00000000000000000000000000000000000000aa',
        symbol: 'USDC',
        decimals: 6
      })

    tracker.observe([held(LCAI(1)), token('1000000'), held(LCAI(2), { chainId: 1 })])

    // A rise in one says nothing about the others.
    const deposits = tracker.observe([
      held(LCAI(1)),
      token('2000000'),
      held(LCAI(2), { chainId: 1 })
    ])
    expect(deposits).toHaveLength(1)
    expect(deposits[0].symbol).toBe('USDC')
    expect(deposits[0].amountWei).toBe('1000000')
  })

  it('ignores a row that is not a number, and never moves its peak for one', () => {
    const tracker = new DepositTracker()
    tracker.observe([held(LCAI(40))])

    expect(tracker.observe([held('not a number')])).toEqual([])

    // The peak is still the honest one: the next rise is measured from 40,
    // not from anything the unreadable row might have meant.
    const deposits = tracker.observe([held(LCAI(45))])
    expect(deposits).toHaveLength(1)
    expect(deposits[0].amountWei).toBe(LCAI(5))
  })

  it('starts from a fresh baseline after a reset, as a new account does', () => {
    const tracker = new DepositTracker()
    tracker.observe([held(LCAI(40))])
    tracker.reset()

    expect(tracker.observe([held(LCAI(40))])).toEqual([])
  })
})
