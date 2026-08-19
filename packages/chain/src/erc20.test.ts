import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import {
  TRANSFER_TOPIC,
  allowanceCall,
  approveCall,
  balanceOfCall,
  decodeTransferResult,
  transferCall
} from './erc20.js'
import { decodeString, decodeUint8 } from './abi.js'

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)'
])

const A = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

describe('call data', () => {
  it('matches viem for every call a wallet makes', () => {
    const cases: [string, readonly unknown[], string][] = [
      ['balanceOf', [A], balanceOfCall(A)],
      ['transfer', [A, 1_000_000n], transferCall(A, 1_000_000n)],
      ['approve', [B, 42n], approveCall(B, 42n)],
      ['allowance', [A, B], allowanceCall(A, B)]
    ]

    for (const [functionName, args, ours] of cases) {
      expect(ours, functionName).toBe(encodeFunctionData({ abi: ABI, functionName, args } as never))
    }
  })

  it('encodes the largest amount a uint256 can hold', () => {
    const max = 2n ** 256n - 1n
    expect(transferCall(A, max)).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [A, max] })
    )
  })

  it('encodes zero, which is how an allowance is revoked', () => {
    expect(approveCall(B, 0n)).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'approve', args: [B, 0n] })
    )
  })
})

describe('the Transfer topic', () => {
  it('is the hash every ERC-20 emits, so history can be found by it', () => {
    expect(TRANSFER_TOPIC).toBe(toEventSelector('Transfer(address,address,uint256)'))
  })
})

describe('what a transfer reports back', () => {
  it('believes a true', () => {
    expect(decodeTransferResult(`0x${'00'.repeat(31)}01`)).toBe(true)
  })

  it('believes a false', () => {
    expect(decodeTransferResult(`0x${'00'.repeat(32)}`)).toBe(false)
  })

  it('treats saying nothing as success', () => {
    // USDT on Ethereum returns nothing at all. The transaction not reverting is
    // the only signal those tokens give, and refusing to read them would mean
    // refusing to show one of the most widely held tokens there is.
    expect(decodeTransferResult('0x')).toBe(true)
    expect(decodeTransferResult('')).toBe(true)
  })
})

describe('reading what a token calls itself', () => {
  const encoded = (text: string) =>
    encodeFunctionData({
      abi: parseAbi(['function f(string s)']),
      functionName: 'f',
      args: [text]
    }).slice(10)

  it('reads the standard dynamic string', () => {
    expect(decodeString(`0x${encoded('USDC')}`)).toBe('USDC')
    expect(decodeString(`0x${encoded('Wrapped Ether')}`)).toBe('Wrapped Ether')
  })

  it('reads a string longer than one word', () => {
    const long = 'a token with a name nobody would choose but somebody did'
    expect(decodeString(`0x${encoded(long)}`)).toBe(long)
  })

  it('reads the bytes32 shape the oldest tokens use', () => {
    // MKR and SAI predate the string return. A decoder that only knows the
    // modern shape throws on exactly the tokens most likely to be held.
    const mkr = '0x4d4b520000000000000000000000000000000000000000000000000000000000'
    expect(decodeString(mkr)).toBe('MKR')
  })

  it('reads an empty answer as an empty name rather than throwing', () => {
    expect(decodeString('0x')).toBe('')
    expect(decodeString(`0x${'00'.repeat(32)}`)).toBe('')
  })

  it('handles a name with characters outside ASCII', () => {
    expect(decodeString(`0x${encoded('Æther')}`)).toBe('Æther')
  })

  it('refuses data that claims to run past its own end', () => {
    const lying = `0x${'00'.repeat(31)}20${'ff'.repeat(32)}`
    expect(() => decodeString(lying)).toThrow(/runs past|offset points past/)
  })
})

describe('decimals', () => {
  it('reads the ordinary values', () => {
    expect(decodeUint8(`0x${'00'.repeat(31)}12`)).toBe(18)
    expect(decodeUint8(`0x${'00'.repeat(31)}06`)).toBe(6)
    expect(decodeUint8(`0x${'00'.repeat(32)}`)).toBe(0)
  })

  it('refuses a value no token could have', () => {
    // Silently accepting 300 would divide a balance by an absurd power of ten,
    // and nothing about the resulting number would look wrong.
    expect(() => decodeUint8(`0x${'00'.repeat(30)}0100`)).toThrow(/out of range/)
  })
})
