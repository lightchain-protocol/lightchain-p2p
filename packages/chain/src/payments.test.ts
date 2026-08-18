import { describe, expect, it } from 'vitest'
import {
  encodeFunctionData,
  keccak256 as viemKeccak,
  parseAbi,
  toFunctionSelector,
  toHex as viemToHex
} from 'viem'
import {
  decodeRevert,
  deposit,
  depositAndAuthorize,
  lightchainErrors,
  modelId,
  setDelegateAllowance,
  setDelegateAuthorization,
  submitJob,
  submitJobOnBehalf,
  withdrawBalance
} from './index.js'

/**
 * viem is the oracle again, for the same reason as before: call data that
 * encodes to something slightly different is not a crash. It is a contract
 * decoding different arguments, or spending a different amount, with nothing
 * downstream noticing.
 */

const abi = parseAbi([
  'function deposit() payable',
  'function depositAndAuthorize(address delegate) payable',
  'function withdrawBalance(uint256 amount)',
  'function setDelegateAuthorization(address delegate, bool authorized)',
  'function setDelegateAllowance(address delegate, uint256 allowance)',
  'function submitJob(uint256 sessionId, bytes32 blobHash) payable returns (uint256)',
  'function submitJobOnBehalf(address user, uint256 sessionId, bytes32 blobHash) returns (uint256)'
])

const DELEGATE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const BLOB = '0x0157c1f0e8b0a5f0a5cba31e8b6da2f3e9a1f2c3d4e5f60718293a4b5c6d7e8f'

describe('paying', () => {
  it('encodes a deposit the way viem does', () => {
    expect(deposit()).toBe(encodeFunctionData({ abi, functionName: 'deposit' }))
  })

  it('encodes depositAndAuthorize the way viem does', () => {
    expect(depositAndAuthorize(DELEGATE)).toBe(
      encodeFunctionData({
        abi,
        functionName: 'depositAndAuthorize',
        args: [DELEGATE as `0x${string}`]
      })
    )
  })

  it('carries no amount, because the deposit is the transaction value', () => {
    // A depositAndAuthorize whose call data mentioned an amount would be a
    // different function. The value is what credits the balance.
    expect(depositAndAuthorize(DELEGATE)).toHaveLength(2 + 8 + 64)
  })

  it('encodes withdrawBalance the way viem does', () => {
    for (const amount of [0n, 1n, 10n ** 18n, 2n ** 255n]) {
      expect(withdrawBalance(amount)).toBe(
        encodeFunctionData({ abi, functionName: 'withdrawBalance', args: [amount] })
      )
    }
  })
})

describe('delegating', () => {
  it('encodes authorisation both ways, the way viem does', () => {
    for (const authorized of [true, false]) {
      expect(setDelegateAuthorization(DELEGATE, authorized)).toBe(
        encodeFunctionData({
          abi,
          functionName: 'setDelegateAuthorization',
          args: [DELEGATE as `0x${string}`, authorized]
        })
      )
    }
  })

  it('encodes an allowance the way viem does', () => {
    expect(setDelegateAllowance(DELEGATE, 5n * 10n ** 17n)).toBe(
      encodeFunctionData({
        abi,
        functionName: 'setDelegateAllowance',
        args: [DELEGATE as `0x${string}`, 5n * 10n ** 17n]
      })
    )
  })
})

describe('submitting a job', () => {
  it('encodes submitJob the way viem does', () => {
    expect(submitJob(7n, BLOB)).toBe(
      encodeFunctionData({ abi, functionName: 'submitJob', args: [7n, BLOB as `0x${string}`] })
    )
  })

  it('encodes submitJobOnBehalf the way viem does', () => {
    expect(submitJobOnBehalf(USER, 7n, BLOB)).toBe(
      encodeFunctionData({
        abi,
        functionName: 'submitJobOnBehalf',
        args: [USER as `0x${string}`, 7n, BLOB as `0x${string}`]
      })
    )
  })

  it('hashes a model name to the id the contracts index by', () => {
    // The worker matches jobs on this hash, so a tag would silently match
    // nothing. Checked against viem hashing the same string.
    expect(modelId('llama3-8b')).toBe(viemKeccak(viemToHex('llama3-8b')))
    // And against what the live testnet indexes its only configured model by.
    expect(modelId('llama3-8b').slice(0, 18)).toBe('0xf4a414fa51803433')
  })
})

describe('reverts', () => {
  const errors = lightchainErrors()

  it('names the error a live testnet call actually produced', () => {
    // Asking for the fee of a model this network does not configure returns
    // exactly these four bytes, and without the table they are all you get.
    expect(decodeRevert('0x04bd4912', errors)).toBe('ModelNotConfigured(bytes32)')
    expect(decodeRevert('0x04bd4912')).toBe('reverted with custom error 0x04bd4912')
  })

  it('computes selectors from signatures rather than trusting a copied table', () => {
    // Selectors verified independently, against viem.
    for (const signature of [
      'ZeroDeposit()',
      'ModelNotConfigured(bytes32)',
      'InsufficientFee(uint256,uint256)',
      'NotAuthorizedDelegate(address,address)'
    ]) {
      const expected = toFunctionSelector(`function ${signature}`)
      expect(errors.get(expected)).toBe(signature)
    }
  })

  it('decodes the arguments, which are the useful part', () => {
    // InsufficientFee(required, provided): 0.02 LCAI wanted, nothing sent.
    const data = '0xa458261b' + (20n * 10n ** 15n).toString(16).padStart(64, '0') + '0'.repeat(64)
    expect(decodeRevert(data, errors)).toBe('InsufficientFee(20000000000000000, 0)')
  })

  it('decodes addresses and bytes32 in errors', () => {
    const data =
      '0x5f65f5df' + '00'.repeat(12) + USER.slice(2) + '00'.repeat(12) + DELEGATE.slice(2)
    expect(decodeRevert(data, errors)).toBe(
      `NotAuthorizedDelegate(${USER.toLowerCase()}, ${DELEGATE.toLowerCase()})`
    )
  })

  it('names an error it cannot decode rather than guessing', () => {
    // ParameterOutOfBounds carries a string, which does not live in a fixed
    // slot. Naming it beats decoding it from the wrong offset.
    const errorsWithDynamic = new Map([
      ['0x62abfbd0', 'ParameterOutOfBounds(string,uint256,uint256,uint256)']
    ])
    expect(decodeRevert('0x62abfbd0' + '00'.repeat(128), errorsWithDynamic)).toBe(
      'ParameterOutOfBounds(string,uint256,uint256,uint256)'
    )
  })

  it('falls back when the arguments are truncated', () => {
    expect(decodeRevert('0xa458261b' + '00'.repeat(8), errors)).toBe(
      'InsufficientFee(uint256,uint256)'
    )
  })

  it('still reads a plain Error(string)', () => {
    const data =
      '0x08c379a0' +
      '0'.repeat(62) +
      '20' +
      '0'.repeat(62) +
      '04' +
      Buffer.from('oops').toString('hex').padEnd(64, '0')
    expect(decodeRevert(data, errors)).toContain('oops')
  })
})
