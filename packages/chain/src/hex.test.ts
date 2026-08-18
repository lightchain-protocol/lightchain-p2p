import { describe, expect, it } from 'vitest'
import { numberToHex, toHex as viemToHex } from 'viem'
import {
  HexError,
  concat,
  fromQuantity,
  isHex,
  toBytes,
  toHex,
  toMinimalBytes,
  toPaddedBytes,
  toQuantity
} from './index.js'

describe('bytes and hex', () => {
  it('round trips', () => {
    for (const hex of ['0x', '0x00', '0xff', '0xdeadbeef', `0x${'ab'.repeat(64)}`]) {
      expect(toHex(toBytes(hex))).toBe(hex)
    }
  })

  it('agrees with viem', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 255])
    expect(toHex(bytes)).toBe(viemToHex(bytes))
  })

  it('refuses input that is not hex, rather than reading part of it', () => {
    // Silently parsing "0xzz" as something would produce bytes nobody chose.
    expect(() => toBytes('deadbeef')).toThrow(HexError)
    expect(() => toBytes('0xzz')).toThrow(HexError)
    expect(() => toBytes('0xabc')).toThrow(/odd length/)
    expect(isHex('0x00')).toBe(true)
    expect(isHex('00')).toBe(false)
  })

  it('concatenates', () => {
    expect(toHex(concat(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)))).toBe('0x010203')
    expect(toHex(concat())).toBe('0x')
  })
})

describe('quantities', () => {
  it('are minimal, as JSON-RPC requires', () => {
    // Geth rejects `0x00` and anything else with a leading zero.
    expect(toQuantity(0n)).toBe('0x0')
    expect(toQuantity(1n)).toBe('0x1')
    expect(toQuantity(15n)).toBe('0xf')
    expect(toQuantity(16n)).toBe('0x10')
    expect(toQuantity(1_000_000_000n)).toBe('0x3b9aca00')
  })

  it('agree with viem', () => {
    for (const value of [0n, 1n, 255n, 256n, 10n ** 18n, (1n << 256n) - 1n]) {
      expect(toQuantity(value)).toBe(numberToHex(value))
    }
  })

  it('read back what a node sends, padded or not', () => {
    expect(fromQuantity('0x0')).toBe(0n)
    expect(fromQuantity('0x')).toBe(0n)
    expect(fromQuantity('0x00')).toBe(0n)
    expect(fromQuantity('0x2008')).toBe(8200n)
  })

  it('refuse a negative amount', () => {
    expect(() => toQuantity(-1n)).toThrow(HexError)
  })
})

describe('integer encodings', () => {
  it('minimal form drops leading zeroes and makes zero empty', () => {
    // RLP has no canonical representation with leading zeroes; a node rejects
    // a transaction that uses one.
    expect(toHex(toMinimalBytes(0n))).toBe('0x')
    expect(toHex(toMinimalBytes(1n))).toBe('0x01')
    expect(toHex(toMinimalBytes(255n))).toBe('0xff')
    expect(toHex(toMinimalBytes(256n))).toBe('0x0100')
  })

  it('padded form is fixed width, as the ABI requires', () => {
    expect(toHex(toPaddedBytes(0n))).toBe(`0x${'00'.repeat(32)}`)
    expect(toHex(toPaddedBytes(1n))).toBe(`0x${'00'.repeat(31)}01`)
    expect(toHex(toPaddedBytes(255n, 4))).toBe('0x000000ff')
  })

  it('refuse a value too large for the width, rather than truncating it', () => {
    // Truncating would encode a different amount than the caller asked for.
    expect(() => toPaddedBytes(1n << 256n, 32)).toThrow(/does not fit/)
    expect(() => toPaddedBytes(256n, 1)).toThrow(/does not fit/)
    expect(() => toMinimalBytes(-1n)).toThrow(HexError)
  })
})
