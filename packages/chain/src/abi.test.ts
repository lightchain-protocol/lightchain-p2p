import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256 as viemKeccak,
  parseAbi,
  toFunctionSelector
} from 'viem'
import {
  AbiError,
  decodeAddress,
  decodeBool,
  decodeRevert,
  decodeUint256,
  encodeCall,
  encodeParameters,
  keccak256,
  selector,
  toHex,
  type AbiType
} from './index.js'
import { createSession, depositAndAuthorize, jobFee, modelId } from './lightchain.js'

/**
 * viem is the oracle.
 *
 * Encoding is the kind of code that looks obviously right and is quietly wrong:
 * a misplaced offset still produces well-formed call data, and the contract
 * decodes it into different arguments rather than rejecting it. Checking the
 * bytes against an independent implementation is the only test worth having.
 *
 * viem cannot run in the worker — it pins a noble version that imports
 * node:crypto, see ADR 0004 — but it runs here, under Node, which is exactly
 * what an oracle needs to do.
 */

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OTHER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('keccak256', () => {
  it('agrees with viem', () => {
    for (const input of ['', 'a', 'aiConfig()', 'llama3-8b', '\u00e9\u00e8\u00ea']) {
      const bytes = new TextEncoder().encode(input)
      expect(toHex(keccak256(bytes))).toBe(viemKeccak(bytes))
    }
  })
})

describe('selectors', () => {
  it('agree with viem for every function this client calls', () => {
    const signatures = [
      'aiConfig()',
      'jobRegistry()',
      'calculateJobFee(bytes32)',
      'prepaidBalanceOf(address)',
      'isDelegateAuthorized(address,address)',
      'depositAndAuthorize(address)',
      'withdrawBalance(uint256)',
      'createSession(bytes32,address,bytes,bytes,bytes,uint256)'
    ]

    for (const signature of signatures) {
      expect(toHex(selector(signature))).toBe(toFunctionSelector(`function ${signature}`))
    }
  })

  it('refuses a signature that is not canonical', () => {
    // `transfer(address to, uint256 amount)` hashes to a different, wrong
    // selector than `transfer(address,uint256)`, and nothing downstream would
    // notice — the call would simply hit no function.
    expect(() => selector('transfer(address to, uint256 amount)')).toThrow(AbiError)
    expect(() => selector('transfer address,uint256')).toThrow(AbiError)
  })
})

describe('parameter encoding', () => {
  const cases: Array<{ name: string; types: AbiType[]; values: unknown[] }> = [
    { name: 'a single address', types: ['address'], values: [ADDRESS] },
    { name: 'zero', types: ['uint256'], values: [0n] },
    { name: 'one wei', types: ['uint256'], values: [1n] },
    { name: 'a whole token', types: ['uint256'], values: [10n ** 18n] },
    { name: 'the largest uint256', types: ['uint256'], values: [(1n << 256n) - 1n] },
    { name: 'a bool', types: ['bool'], values: [true] },
    { name: 'two addresses', types: ['address', 'address'], values: [ADDRESS, OTHER] },
    {
      name: 'empty bytes',
      types: ['bytes'],
      values: [new Uint8Array(0)]
    },
    {
      name: 'bytes needing padding',
      types: ['bytes'],
      values: [Uint8Array.from([1, 2, 3])]
    },
    {
      name: 'bytes on an exact 32-byte boundary',
      types: ['bytes'],
      values: [new Uint8Array(32).fill(7)]
    },
    {
      name: 'bytes spanning two words',
      types: ['bytes'],
      values: [new Uint8Array(65).fill(4)]
    },
    {
      name: 'static and dynamic mixed, which is where offsets go wrong',
      types: ['bytes32', 'address', 'bytes', 'bytes', 'bytes', 'uint256'],
      values: [
        new Uint8Array(32).fill(9),
        ADDRESS,
        new Uint8Array(65).fill(1),
        new Uint8Array(97).fill(2),
        new Uint8Array(3).fill(3),
        1893456000n
      ]
    }
  ]

  for (const { name, types, values } of cases) {
    it(`matches viem for ${name}`, () => {
      const mine = toHex(encodeParameters(types, values as never))
      const theirs = encodeAbiParameters(
        types.map((type) => ({ type })),
        values.map((v) => (v instanceof Uint8Array ? toHex(v) : v)) as never
      )
      expect(mine).toBe(theirs)
    })
  }
})

describe('call data', () => {
  it('matches viem for the real Lightchain functions', () => {
    const abi = parseAbi([
      'function depositAndAuthorize(address delegate)',
      'function withdrawBalance(uint256 amount)',
      'function prepaidBalanceOf(address user)',
      'function calculateJobFee(bytes32 modelId)',
      'function createSession(bytes32 modelId, address worker, bytes encWorkerKey, bytes encDisputerKey, bytes dispatcherSignature, uint256 expiry)'
    ])

    expect(depositAndAuthorize(ADDRESS)).toBe(
      encodeFunctionData({ abi, functionName: 'depositAndAuthorize', args: [ADDRESS] })
    )

    expect(encodeCall('withdrawBalance(uint256)', ['uint256'], [123456789n])).toBe(
      encodeFunctionData({ abi, functionName: 'withdrawBalance', args: [123456789n] })
    )

    const session = {
      model: 'llama3-8b',
      worker: OTHER,
      encWorkerKey: new Uint8Array(113).fill(0xaa),
      encDisputerKey: new Uint8Array(113).fill(0xbb),
      dispatcherSignature: new Uint8Array(65).fill(0xcc),
      expiry: 1893456000n
    }

    expect(createSession(session)).toBe(
      encodeFunctionData({
        abi,
        functionName: 'createSession',
        args: [
          modelId(session.model) as `0x${string}`,
          session.worker as `0x${string}`,
          toHex(session.encWorkerKey) as `0x${string}`,
          toHex(session.encDisputerKey) as `0x${string}`,
          toHex(session.dispatcherSignature) as `0x${string}`,
          session.expiry
        ]
      })
    )
  })

  it('rejects arguments of the wrong shape rather than encoding something plausible', () => {
    expect(() => encodeParameters(['address'], ['0xnope'])).toThrow(AbiError)
    expect(() => encodeParameters(['uint256'], [-1n])).toThrow(AbiError)
    expect(() => encodeParameters(['uint256'], [1n << 256n])).toThrow(AbiError)
    expect(() => encodeParameters(['uint256'], [1 as never])).toThrow(/must be a bigint/)
    expect(() => encodeParameters(['bytes32'], [new Uint8Array(31)])).toThrow(/32 bytes/)
    expect(() => encodeParameters(['address', 'uint256'], [ADDRESS])).toThrow(/expected 2 values/)
  })
})

describe('model ids', () => {
  it('is the hash of the plain name', () => {
    expect(modelId('llama3-8b')).toBe(viemKeccak(new TextEncoder().encode('llama3-8b')))
  })

  it('refuses a tagged name', () => {
    // The worker matches jobs on the hash of the untagged name, so a tag makes
    // every job silently fail to resolve.
    expect(() => modelId('llama3-8b:latest')).toThrow(/must not carry a tag/)
  })
})

describe('decoding', () => {
  it('reads an address from a padded word', () => {
    expect(decodeAddress(`0x${'00'.repeat(12)}${ADDRESS.slice(2)}`)).toBe(ADDRESS.toLowerCase())
  })

  it('refuses a word that is not a padded address', () => {
    // Dirty high bytes mean this is not an address, and taking the low 20
    // would invent one that looks entirely legitimate.
    expect(() => decodeAddress(`0x${'11'.repeat(32)}`)).toThrow(/left-padded/)
    expect(() => decodeAddress('0x1234')).toThrow(/32-byte word/)
  })

  it('reads uint256 and bool', () => {
    expect(decodeUint256(`0x${'00'.repeat(31)}ff`)).toBe(255n)
    expect(decodeUint256(`0x${'ff'.repeat(32)}`)).toBe((1n << 256n) - 1n)
    expect(decodeBool(`0x${'00'.repeat(32)}`)).toBe(false)
    expect(decodeBool(`0x${'00'.repeat(31)}01`)).toBe(true)
    expect(() => decodeBool(`0x${'00'.repeat(31)}02`)).toThrow(/neither 0 nor 1/)
  })
})

describe('revert reasons', () => {
  it('reads Error(string)', () => {
    // What a node returns for `require(false, "insufficient balance")`.
    const encoded =
      '0x08c379a0' + encodeAbiParameters([{ type: 'string' }], ['insufficient balance']).slice(2)
    expect(decodeRevert(encoded)).toBe('insufficient balance')
  })

  it('reports a custom error by selector rather than pretending to read it', () => {
    // ModelNotConfigured(bytes32) and friends need an ABI this package does not
    // carry, so the selector is the honest answer.
    const custom = toFunctionSelector('function ModelNotConfigured(bytes32)')
    expect(decodeRevert(custom)).toBe(`reverted with custom error ${custom}`)
  })

  it('returns null when there is nothing to read', () => {
    expect(decodeRevert('0x')).toBeNull()
    expect(decodeRevert('not hex')).toBeNull()
  })
})

describe('the fee call', () => {
  it('asks the right question', async () => {
    // A fake RPC, so this asserts what goes on the wire rather than what comes
    // back from a node that might be down.
    let seen: { to: string; data: string } | null = null
    const rpc = {
      call: async (request: { to: string; data: string }) => {
        seen = request
        return `0x${12345n.toString(16).padStart(64, '0')}`
      }
    }

    const fee = await jobFee(rpc as never, ADDRESS, 'llama3-8b')

    expect(fee).toBe(12345n)
    expect(seen!.to).toBe(ADDRESS)
    expect(seen!.data).toBe(
      encodeFunctionData({
        abi: parseAbi(['function calculateJobFee(bytes32 modelId)']),
        functionName: 'calculateJobFee',
        args: [modelId('llama3-8b') as `0x${string}`]
      })
    )
  })
})
