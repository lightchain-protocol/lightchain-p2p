import { describe, expect, it } from 'vitest'
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem'
import { aggregate3Call, decodeAggregate3 } from './multicall.js'
import { balanceOfCall } from './erc20.js'

/**
 * viem is the oracle, as it is for the rest of the encoding in this package.
 *
 * `aggregate3` takes an array of structs, which the encoder in `abi.ts` does
 * not do, so the call is laid out by hand — offsets, a table of pointers, and
 * word-aligned padding written out longhand. That is the kind of code that is
 * either exactly right or subtly wrong in a way that reads as a token having no
 * balance, so it is checked byte for byte against an independent encoder.
 */

const ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) returns (Result[] returnData)'
])

const A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const B = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const HOLDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const viemCall = (calls: { to: string; data: string }[]) =>
  encodeFunctionData({
    abi: ABI,
    functionName: 'aggregate3',
    args: [
      calls.map((c) => ({
        target: c.to as `0x${string}`,
        allowFailure: true,
        callData: c.data as `0x${string}`
      }))
    ]
  })

describe('encoding a batch', () => {
  it('matches viem for one call', () => {
    const calls = [{ to: A, data: balanceOfCall(HOLDER) }]
    expect(aggregate3Call(calls)).toBe(viemCall(calls))
  })

  it('matches viem for several', () => {
    const calls = [
      { to: A, data: balanceOfCall(HOLDER) },
      { to: B, data: balanceOfCall(HOLDER) },
      { to: A, data: '0x313ce567' }
    ]
    expect(aggregate3Call(calls)).toBe(viemCall(calls))
  })

  it('matches viem when call data needs padding to a word', () => {
    // Four bytes, twenty bytes, thirty-six — none of them a multiple of 32, so
    // each one exercises the padding arithmetic differently.
    for (const size of [0, 4, 20, 36, 64, 100]) {
      const calls = [
        { to: A, data: `0x${'ab'.repeat(size)}` },
        { to: B, data: balanceOfCall(HOLDER) }
      ]
      expect(aggregate3Call(calls), `${size} bytes`).toBe(viemCall(calls))
    }
  })

  it('matches viem for an empty batch', () => {
    expect(aggregate3Call([])).toBe(viemCall([]))
  })
})

describe('decoding what comes back', () => {
  /** What a node would return, built by viem so the test does not mark its own homework. */
  const encodeResults = (results: { success: boolean; returnData: string }[]) =>
    encodeFunctionData({
      abi: parseAbi([
        'struct Result { bool success; bytes returnData; }',
        'function f(Result[] r)'
      ]),
      functionName: 'f',
      args: [
        results.map((r) => ({ success: r.success, returnData: r.returnData as `0x${string}` }))
      ]
      // The selector is four bytes at the front; a return value has none.
    }).slice(10)

  it('reads a single successful result', () => {
    const word = `0x${'00'.repeat(31)}2a`
    const out = decodeAggregate3(`0x${encodeResults([{ success: true, returnData: word }])}`)

    expect(out).toHaveLength(1)
    expect(out[0]?.success).toBe(true)
    expect(out[0]?.data).toBe(word)
  })

  it('keeps results in order and reports failures individually', () => {
    const first = `0x${'00'.repeat(31)}01`
    const third = `0x${'00'.repeat(31)}03`
    const out = decodeAggregate3(
      `0x${encodeResults([
        { success: true, returnData: first },
        { success: false, returnData: '0x' },
        { success: true, returnData: third }
      ])}`
    )

    expect(out.map((r) => r.success)).toEqual([true, false, true])
    expect(out.map((r) => r.data)).toEqual([first, '0x', third])
  })

  it('handles return data that is not a whole number of words', () => {
    const odd = '0xdeadbeef'
    const out = decodeAggregate3(`0x${encodeResults([{ success: true, returnData: odd }])}`)
    expect(out[0]?.data).toBe(odd)
  })

  it('round-trips against viem for a realistic batch', () => {
    const results = [
      { success: true, returnData: `0x${'00'.repeat(24)}${'11'.repeat(8)}` },
      { success: false, returnData: '0x' },
      { success: true, returnData: `0x${'00'.repeat(31)}06` }
    ]
    const raw = `0x${encodeResults(results)}` as `0x${string}`

    const theirs = decodeFunctionResult({
      abi: ABI,
      functionName: 'aggregate3',
      data: raw
    }) as readonly { success: boolean; returnData: string }[]

    const ours = decodeAggregate3(raw)
    expect(ours.map((r) => r.success)).toEqual(theirs.map((r) => r.success))
    expect(ours.map((r) => r.data)).toEqual(theirs.map((r) => r.returnData))
  })

  it('refuses something far too short to be a batch', () => {
    expect(() => decodeAggregate3('0x1234')).toThrow(/aggregate3 returned/)
  })
})
