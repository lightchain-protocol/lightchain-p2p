import { describe, expect, it } from 'vitest'
import { formatUnits, lcai, plainUnits, toBaseUnits } from '../renderer/lib/amounts.js'

/**
 * Turning what somebody typed into what gets signed.
 *
 * This is the shortest path in the application between a keystroke and money
 * leaving, and it is arithmetic on strings for a reason: `0.1` of an
 * eighteen-decimal token is 10^17, which no double holds exactly, and
 * `parseFloat` on a balance in wei loses digits from about a hundredth of a
 * token upwards — precisely the range people send.
 */

describe('reading an amount somebody typed', () => {
  it('reads whole numbers', () => {
    expect(toBaseUnits('1', 18)).toBe(10n ** 18n)
    expect(toBaseUnits('1000', 6)).toBe(1_000_000_000n)
  })

  it('reads fractions exactly, where a float would not', () => {
    // 0.1 + 0.2 !== 0.3 in a double. Here it is exact because it never becomes
    // one.
    expect(toBaseUnits('0.1', 18)).toBe(100_000_000_000_000_000n)
    expect(toBaseUnits('0.3', 18)).toBe(300_000_000_000_000_000n)
  })

  it('keeps every digit of a long fraction', () => {
    expect(toBaseUnits('1.123456789012345678', 18)).toBe(1_123_456_789_012_345_678n)
  })

  it('handles the six-decimal tokens that catch people out', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n)
    expect(toBaseUnits('0.000001', 6)).toBe(1n)
  })

  it('reads an amount larger than a double could hold', () => {
    expect(toBaseUnits('123456789.123456789012345678', 18)).toBe(
      123_456_789_123_456_789_012_345_678n
    )
  })

  it('refuses more decimal places than the token has', () => {
    // Accepting it would round somebody's amount silently, and the direction of
    // the rounding is not theirs to discover afterwards.
    expect(toBaseUnits('1.1234567', 6)).toBe(null)
    expect(toBaseUnits('0.0000000000000000001', 18)).toBe(null)
  })

  it('refuses anything that is not a number', () => {
    for (const bad of ['', '.', 'lots', '1e18', '-1', '1,5', '0x10', ' ', null, undefined]) {
      expect(toBaseUnits(bad, 18), String(bad)).toBe(null)
    }
  })

  it('accepts the shapes people actually type', () => {
    expect(toBaseUnits('.5', 18)).toBe(5n * 10n ** 17n)
    expect(toBaseUnits('5.', 18)).toBe(5n * 10n ** 18n)
    expect(toBaseUnits(' 1.5 ', 18)).toBe(15n * 10n ** 17n)
  })

  it('reads zero as zero rather than as nothing', () => {
    // The caller refuses zero separately, with its own message. Conflating the
    // two here would report "enter an amount" to somebody who entered one.
    expect(toBaseUnits('0', 18)).toBe(0n)
    expect(toBaseUnits('0.0', 18)).toBe(0n)
  })
})

describe('showing a balance', () => {
  it('shows whole amounts without a point', () => {
    expect(formatUnits('1000000000000000000', 18)).toBe('1')
    expect(formatUnits('0', 18)).toBe('0')
  })

  it('groups thousands, because a balance is read at a glance', () => {
    expect(formatUnits('1234567000000000000000', 18)).toBe('1,234.567')
  })

  it('drops trailing zeros', () => {
    expect(formatUnits('1500000000000000000', 18)).toBe('1.5')
  })

  it('caps the fraction so a row stays readable', () => {
    expect(formatUnits('1123456789012345678', 18)).toBe('1.123456')
  })

  it('can be asked for every digit, which is what Max needs', () => {
    // Max fills the field with the exact balance. Truncating there would send
    // less than the whole balance while claiming to send all of it.
    expect(formatUnits('1123456789012345678', 18, 18)).toBe('1.123456789012345678')
  })

  it('handles six-decimal tokens', () => {
    expect(formatUnits('1500000', 6)).toBe('1.5')
    expect(formatUnits('1', 6)).toBe('0.000001')
  })

  it('does not round a small balance away to zero', () => {
    expect(formatUnits('1', 18, 18)).toBe('0.000000000000000001')
  })

  it('survives a balance far past what a double holds', () => {
    expect(formatUnits('123456789123456789012345678', 18)).toBe('123,456,789.123456')
  })
})

describe('what the Max button fills in', () => {
  it('never contains a grouping comma', () => {
    // `formatUnits` groups thousands, which reads well and is not a number.
    // Filling the field with "1,234.5" hands somebody an amount the parser then
    // refuses, on the one control whose whole job is to be exactly right.
    expect(formatUnits('1234500000000000000000', 18)).toContain(',')
    expect(plainUnits('1234500000000000000000', 18)).toBe('1234.5')
  })

  it('drops trailing zeros rather than padding to the token width', () => {
    expect(plainUnits('1000000000000000000', 18)).toBe('1')
    expect(plainUnits('1500000', 6)).toBe('1.5')
  })

  it('keeps a tiny balance rather than rounding it to nothing', () => {
    expect(plainUnits('1', 18)).toBe('0.000000000000000001')
  })

  it('round-trips back to the exact balance it came from', () => {
    for (const [base, decimals] of [
      ['1', 18],
      ['1000000', 6],
      ['1123456789012345678', 18],
      ['999999999999999999999999', 18],
      ['1', 6],
      ['0', 18]
    ]) {
      const shown = plainUnits(base, decimals)
      expect(toBaseUnits(shown, decimals)?.toString(), `${base} @ ${decimals}`).toBe(base)
    }
  })
})

/**
 * The two setup pages each had a copy of this, and the copies performed the
 * same two steps in opposite orders — so one of them was wrong on any amount
 * whose significant digit followed a run of zeros.
 */
describe('lcai', () => {
  it('writes whole amounts with thousands separators', () => {
    expect(lcai(500_000n * 10n ** 18n)).toBe('500,000')
    expect(lcai(0n)).toBe('0')
    expect(lcai('1000000000000000000')).toBe('1')
  })

  it('keeps four decimal places and no more', () => {
    // A shortfall is arithmetic between two balances, so it arrives with all
    // eighteen decimals attached.
    expect(lcai('50000500000420201387974')).toBe('50,000.5')
  })

  it('strips the zeros it added, not the ones inside the number', () => {
    // The defect in the copy that stripped before truncating.
    expect(lcai(100_500_000_000_000_000n)).toBe('0.1005')
    expect(lcai(100_050_000_000_000_000n)).toBe('0.1')
    expect(lcai(500_000_000_000_000_000n)).toBe('0.5')
  })
})
