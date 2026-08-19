import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import {
  BRIDGE,
  LIGHTCHAIN_DOMAIN,
  decodeQuote,
  quoteTransferRemoteCall,
  toBytes32,
  transferRemoteCall
} from './hyperlane.js'
import { AbiError } from './abi.js'

/**
 * The bridge encoding, where being wrong costs the whole transfer.
 *
 * A recipient padded the wrong way delivers to a different address. A quote
 * read the wrong way approves the wrong amount. Neither errors — both produce a
 * transaction that is accepted and does something other than what was meant.
 */

const ABI = parseAbi([
  'function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32)',
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns ((address,uint256)[])'
])

const ANYONE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const ONE = 10n ** 18n

describe('addressing a recipient', () => {
  it('left-pads into a word, as the protocol expects', () => {
    const padded = toBytes32(ANYONE)
    expect(padded).toHaveLength(32)
    expect([...padded.slice(0, 12)].every((b) => b === 0)).toBe(true)
    expect(Buffer.from(padded.slice(12)).toString('hex')).toBe(ANYONE.slice(2).toLowerCase())
  })

  it('refuses anything that is not an address', () => {
    for (const bad of ['', '0x', ANYONE.slice(0, -1), `${ANYONE}00`, 'not an address']) {
      expect(() => toBytes32(bad), bad).toThrow(AbiError)
    }
  })
})

describe('call data', () => {
  it('matches viem for a transfer', () => {
    expect(transferRemoteCall(LIGHTCHAIN_DOMAIN, ANYONE, ONE)).toBe(
      encodeFunctionData({
        abi: ABI,
        functionName: 'transferRemote',
        args: [LIGHTCHAIN_DOMAIN, toBytes32Hex(ANYONE), ONE]
      })
    )
  })

  it('matches viem for a quote', () => {
    expect(quoteTransferRemoteCall(LIGHTCHAIN_DOMAIN, ANYONE, ONE)).toBe(
      encodeFunctionData({
        abi: ABI,
        functionName: 'quoteTransferRemote',
        args: [LIGHTCHAIN_DOMAIN, toBytes32Hex(ANYONE), ONE]
      })
    )
  })

  it('hashes the uint32 signature, not the uint256 it encodes as', () => {
    // The signature decides the selector; the width on the wire is a full word
    // either way. Making those agree would break one of them.
    expect(transferRemoteCall(1, ANYONE, 1n).slice(0, 10)).toBe(
      toFunctionSelector('transferRemote(uint32,bytes32,uint256)')
    )
  })
})

describe('reading a quote', () => {
  /** The shape the live routes return: an offset, a count, then pairs. */
  const quote = (pairs: [string, bigint][]) =>
    '0x' +
    word(32n) +
    word(BigInt(pairs.length)) +
    pairs.map(([token, amount]) => word(BigInt(token)) + word(amount)).join('')

  const word = (value: bigint) => value.toString(16).padStart(64, '0')

  it('takes the native fee from the first entry', () => {
    const read = decodeQuote(
      quote([
        ['0x0', 500n],
        [BRIDGE.ethereumToken, ONE]
      ]),
      ONE
    )
    expect(read.native).toBe(500n)
  })

  it('takes the token amount from the second', () => {
    const read = decodeQuote(
      quote([
        ['0x0', 0n],
        [BRIDGE.ethereumToken, ONE + 7n]
      ]),
      ONE
    )
    expect(read.token).toBe(ONE + 7n)
  })

  it('ignores a third entry naming the same token', () => {
    // This is the live shape and the bug it caused. A decoder keying on the
    // address rather than the position takes whichever entry it saw last, and
    // this route's third entry is the same token with a zero amount — so every
    // Ethereum-side transfer would have been approved for nothing.
    const read = decodeQuote(
      quote([
        ['0x0', 0n],
        [BRIDGE.ethereumToken, ONE],
        [BRIDGE.ethereumToken, 0n]
      ]),
      ONE
    )
    expect(read.token).toBe(ONE)
    expect(read.native).toBe(0n)
  })

  it('reads the native route, whose second entry is also a zero address', () => {
    // On the native side every entry names the zero address, because the thing
    // being moved is the native coin. Position is the only thing that
    // distinguishes the fee from the amount.
    const read = decodeQuote(
      quote([
        ['0x0', 0n],
        ['0x0', ONE],
        ['0x0', 0n]
      ]),
      ONE
    )
    expect(read.native).toBe(0n)
    expect(read.token).toBe(ONE)
  })

  it('falls back to the amount asked for rather than to zero', () => {
    // An unreadable quote should produce a transfer that is over-approved and
    // works, never one that is under-approved and reverts.
    expect(decodeQuote('0x', ONE).token).toBe(ONE)
    expect(decodeQuote(quote([['0x0', 0n]]), ONE).token).toBe(ONE)
    expect(
      decodeQuote(
        quote([
          ['0x0', 0n],
          ['0x0', 0n]
        ]),
        ONE
      ).token
    ).toBe(ONE)
  })

  it('keeps a fee larger than the amount, rather than assuming it is a mistake', () => {
    const read = decodeQuote(
      quote([
        ['0x0', ONE * 2n],
        ['0x0', ONE]
      ]),
      ONE
    )
    expect(read.native).toBe(ONE * 2n)
  })
})

describe('the addresses this code will send to', () => {
  it('are the ones verified on chain', () => {
    // Checked against the chains by `scripts/survey-bridge.mjs`. Restated here
    // so that changing one without running that survey fails immediately.
    expect(BRIDGE.ethereumRouter).toBe('0x01f80bb8e78e79881E8Ec7832fB6C2c59f64e353')
    expect(BRIDGE.lightchainRouter).toBe('0xEc7096A3116EE769457C939617375Ec1785AA6f1')
    expect(BRIDGE.ethereumToken).toBe('0x9cA8530CA349c966Fe9ef903Df17a75B8A778927')
  })
})

function toBytes32Hex(address: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as `0x${string}`
}
