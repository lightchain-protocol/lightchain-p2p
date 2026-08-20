import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import {
  LCAI_MAINNET,
  POOL_FEES,
  UNISWAP,
  decodePoolAddress,
  decodeQuotedSwap,
  exactInputSingleCall,
  getPoolCall,
  liquidityCall,
  minimumReceived,
  multicallWithDeadline,
  quoteExactInputSingleCall
} from './uniswap.js'
import { AbiError } from './abi.js'

/**
 * The Uniswap encoding, where a wrong byte spends real money on mainnet.
 *
 * Every call here is checked against viem, the independent oracle this package
 * uses throughout. The two facts that most want pinning are the ones this
 * module relies on structurally: that a tuple of static members encodes as the
 * flat concatenation of their words, and that `multicall(uint256,bytes[])` lays
 * its array out the way {@link multicallWithDeadline} builds it.
 */

const ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function liquidity() view returns (uint128)'
])

const WETH = UNISWAP.weth
const LCAI = LCAI_MAINNET
const ANYONE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const ONE = 10n ** 18n

describe('the addresses this code will send to', () => {
  it('are the ones verified against the deployments page and on chain', () => {
    // Restated so that changing one without re-verifying fails immediately.
    expect(UNISWAP.factory).toBe('0x1F98431c8aD98523631AE4a59f267346ea31F984')
    expect(UNISWAP.quoterV2).toBe('0x61fFE014bA17989E743c5F6cB21bF9697530B21e')
    expect(UNISWAP.swapRouter02).toBe('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45')
    expect(UNISWAP.weth).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
    expect(LCAI_MAINNET).toBe('0x9cA8530CA349c966Fe9ef903Df17a75B8A778927')
    expect(POOL_FEES).toEqual([500, 3000, 10000])
  })
})

describe('discovering a pool', () => {
  it('matches viem for getPool', () => {
    expect(getPoolCall(LCAI, WETH, 3000)).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'getPool', args: [LCAI, WETH, 3000] })
    )
  })

  it('matches viem for liquidity', () => {
    expect(liquidityCall()).toBe(encodeFunctionData({ abi: ABI, functionName: 'liquidity' }))
  })

  it('reads a pool address, and the zero address as no pool', () => {
    const word = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
    expect(decodePoolAddress(word('0x0d047a370611437a1b8e6c2a95ea36f69fdda3be'))).toBe(
      '0x0d047a370611437a1b8e6c2a95ea36f69fdda3be'
    )
    expect(decodePoolAddress(`0x${'0'.repeat(64)}`)).toBe(null)
  })

  it('refuses a word that is not a left-padded address', () => {
    expect(() => decodePoolAddress(`0x${'ff'.repeat(32)}`)).toThrow(AbiError)
    expect(() => decodePoolAddress('0x1234')).toThrow(AbiError)
  })
})

describe('quoting', () => {
  it('matches viem, struct argument and all', () => {
    const leg = { tokenIn: WETH, tokenOut: LCAI, fee: 3000, amountIn: ONE }
    expect(quoteExactInputSingleCall(leg)).toBe(
      encodeFunctionData({
        abi: ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: WETH, tokenOut: LCAI, amountIn: ONE, fee: 3000, sqrtPriceLimitX96: 0n }]
      })
    )
  })

  it('hashes the tuple signature, not a flat one', () => {
    const leg = { tokenIn: WETH, tokenOut: LCAI, fee: 3000, amountIn: 1n }
    expect(quoteExactInputSingleCall(leg).slice(0, 10)).toBe(
      toFunctionSelector('quoteExactInputSingle((address,address,uint256,uint24,uint160))')
    )
  })

  it('decodes the four return words by position', () => {
    const word = (value: bigint) => value.toString(16).padStart(64, '0')
    const read = decodeQuotedSwap(`0x${word(ONE)}${word(2n ** 96n)}${word(3n)}${word(93_181n)}`)
    expect(read.amountOut).toBe(ONE)
    expect(read.sqrtPriceX96After).toBe(2n ** 96n)
    expect(read.initializedTicksCrossed).toBe(3)
    expect(read.gasEstimate).toBe(93_181n)
  })

  it('refuses a short return rather than inventing a quote', () => {
    expect(() => decodeQuotedSwap('0x')).toThrow(AbiError)
    expect(() => decodeQuotedSwap(`0x${'0'.repeat(64)}`)).toThrow(AbiError)
  })
})

describe('the swap itself', () => {
  const leg = { tokenIn: WETH, tokenOut: LCAI, fee: 3000, amountIn: ONE }

  it('matches viem for exactInputSingle', () => {
    expect(exactInputSingleCall(leg, ANYONE, ONE - 5n)).toBe(
      encodeFunctionData({
        abi: ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: WETH,
            tokenOut: LCAI,
            fee: 3000,
            recipient: ANYONE,
            amountIn: ONE,
            amountOutMinimum: ONE - 5n,
            sqrtPriceLimitX96: 0n
          }
        ]
      })
    )
  })

  it('matches viem for the deadline wrapper, one call', () => {
    const inner = exactInputSingleCall(leg, ANYONE, ONE)
    expect(multicallWithDeadline(1_800_000_000n, [inner])).toBe(
      encodeFunctionData({
        abi: ABI,
        functionName: 'multicall',
        args: [1_800_000_000n, [inner as `0x${string}`]]
      })
    )
  })

  it('matches viem for the deadline wrapper, several calls', () => {
    const one = exactInputSingleCall(leg, ANYONE, ONE)
    const two = exactInputSingleCall({ ...leg, fee: 500 }, ANYONE, ONE * 2n)
    expect(multicallWithDeadline(1_800_000_000n, [one, two])).toBe(
      encodeFunctionData({
        abi: ABI,
        functionName: 'multicall',
        args: [1_800_000_000n, [one as `0x${string}`, two as `0x${string}`]]
      })
    )
  })

  it('refuses an empty multicall', () => {
    expect(() => multicallWithDeadline(1n, [])).toThrow(AbiError)
  })
})

describe('the slippage bound', () => {
  it('scales the quote down by the tolerance', () => {
    expect(minimumReceived(10_000n, 50)).toBe(9_950n)
    expect(minimumReceived(10_000n, 10)).toBe(9_990n)
    expect(minimumReceived(10_000n, 100)).toBe(9_900n)
    expect(minimumReceived(10_000n, 0)).toBe(10_000n)
  })

  it('rounds down, never in the sender\'s favour', () => {
    // 333 * 0.995 = 331.335 — the receiver of the rounding error must be the
    // pool, not the person signing.
    expect(minimumReceived(333n, 50)).toBe(331n)
  })

  it('refuses a tolerance outside the range', () => {
    expect(() => minimumReceived(1n, -1)).toThrow(AbiError)
    expect(() => minimumReceived(1n, 10_001)).toThrow(AbiError)
    expect(() => minimumReceived(1n, 0.5)).toThrow(AbiError)
  })
})
