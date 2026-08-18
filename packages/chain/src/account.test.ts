import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress, recoverTransactionAddress, toRlp } from 'viem'
import { AccountError, fromPrivateKey, rlp, toBytes, toHex, type Transaction } from './index.js'

/**
 * viem is the oracle again, and here it matters most.
 *
 * A wrong signature is not a bug that shows up in testing — it is a
 * transaction a node rejects, or worse, one it accepts that says something
 * other than what was meant. Every signature below is compared byte-for-byte
 * with viem's, and separately recovered back to the signing address.
 *
 * The keys are Anvil's published test keys. They are public, hold nothing, and
 * exist so that examples like this can be reproduced.
 */

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const SECOND = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const mine = fromPrivateKey(KEY)
const theirs = privateKeyToAccount(KEY)

describe('addresses', () => {
  it('derive the same address viem does, checksummed', () => {
    expect(mine.address).toBe(theirs.address)
    // Mixed case, not lowercase: EIP-55 is the only protection against a
    // mistyped address, and every explorer and wallet shows it this way.
    expect(mine.address).not.toBe(mine.address.toLowerCase())
  })

  it('derives a different address from a different key', () => {
    expect(fromPrivateKey(SECOND).address).toBe(privateKeyToAccount(SECOND).address)
    expect(fromPrivateKey(SECOND).address).not.toBe(mine.address)
  })

  it('refuses a key that is not one', () => {
    expect(() => fromPrivateKey('0x00')).toThrow(AccountError)
    expect(() => fromPrivateKey(`0x${'00'.repeat(32)}`)).toThrow(/valid secp256k1/)
    // n itself is out of range; the valid scalars are 1..n-1.
    const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
    expect(() => fromPrivateKey(`0x${order}`)).toThrow(/valid secp256k1/)
  })

  it('does not carry the private key on the account', () => {
    // Anything that logs or serialises an account must not leak the key.
    expect(JSON.stringify(mine)).not.toContain(KEY.slice(2))
    expect(Object.values(mine).join(' ')).not.toContain(KEY.slice(2))
  })
})

describe('RLP', () => {
  it('agrees with viem across the awkward cases', () => {
    const cases: Array<Uint8Array | Uint8Array[]> = [
      new Uint8Array(0),
      Uint8Array.of(0x00),
      Uint8Array.of(0x7f),
      Uint8Array.of(0x80),
      new Uint8Array(55).fill(1),
      new Uint8Array(56).fill(1),
      new Uint8Array(1024).fill(2),
      [],
      [new Uint8Array(0)],
      [Uint8Array.of(1), Uint8Array.of(2)],
      [new Uint8Array(60).fill(3), new Uint8Array(60).fill(4)]
    ]

    for (const input of cases) {
      const viemInput = Array.isArray(input)
        ? input.map((b) => toHex(b) as `0x${string}`)
        : (toHex(input) as `0x${string}`)
      expect(toHex(rlp.encode(input))).toBe(toRlp(viemInput))
    }
  })

  it('encodes zero as empty, not as a zero byte', () => {
    // Leading zeroes are non-canonical and a node rejects them outright.
    expect(toHex(rlp.number(0n))).toBe('0x')
    expect(toHex(rlp.number(1n))).toBe('0x01')
    expect(toHex(rlp.number(256n))).toBe('0x0100')
  })
})

describe('transactions', () => {
  const base: Transaction = {
    chainId: 8200,
    nonce: 0n,
    to: '0x0000000000000000000000000000000000001002',
    value: 0n,
    data: '0x',
    gas: 21000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n
  }

  const variants: Array<{ name: string; tx: Transaction }> = [
    { name: 'the simplest transfer', tx: base },
    { name: 'a nonce past the first', tx: { ...base, nonce: 42n } },
    { name: 'a value attached', tx: { ...base, value: 10n ** 18n } },
    { name: 'call data', tx: { ...base, data: `0x${'ab'.repeat(100)}`, gas: 200_000n } },
    { name: 'differing fee caps', tx: { ...base, maxPriorityFeePerGas: 1n } },
    {
      name: 'a large nonce and large fees',
      tx: { ...base, nonce: 65_535n, maxFeePerGas: 2n ** 40n }
    },
    { name: 'mainnet rather than testnet', tx: { ...base, chainId: 9200 } }
  ]

  for (const { name, tx } of variants) {
    it(`serialises and signs ${name} exactly as viem does`, async () => {
      const signed = mine.signTransaction(tx)

      const expected = await theirs.signTransaction({
        chainId: tx.chainId,
        nonce: Number(tx.nonce),
        to: tx.to as `0x${string}`,
        value: tx.value,
        data: tx.data as `0x${string}`,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        type: 'eip1559'
      })

      expect(signed).toBe(expected)
      // 0x02 marks EIP-1559. A legacy transaction would be replayable across
      // chains in ways this format is designed to prevent.
      expect(signed.startsWith('0x02')).toBe(true)

      // And independently: the signature recovers to the sender.
      const recovered = await recoverTransactionAddress({
        serializedTransaction: signed as `0x02${string}`
      })
      expect(recovered).toBe(mine.address)
    })
  }

  it('refuses to sign without a real chain id', async () => {
    // A missing or wrong chain id is exactly what makes a signed transaction
    // replayable on a different chain.
    expect(() => mine.signTransaction({ ...base, chainId: 0 })).toThrow(/chainId/)
    expect(() => mine.signTransaction({ ...base, chainId: -1 })).toThrow(/chainId/)
    expect(() => mine.signTransaction({ ...base, chainId: 1.5 })).toThrow(/chainId/)
  })

  it('refuses a recipient that is not an address', () => {
    expect(() => mine.signTransaction({ ...base, to: '0x1234' })).toThrow(/20-byte address/)
  })

  it('signs deterministically, so the same transaction is the same bytes', () => {
    // RFC 6979. Two different signatures for one transaction would mean the
    // nonce came from somewhere non-deterministic.
    expect(mine.signTransaction(base)).toBe(mine.signTransaction(base))
  })
})

describe('messages', () => {
  it('signs the same bytes as viem and recovers to the signer', async () => {
    for (const message of ['', 'hello', 'lightchain', '\u00e9 unicode \u4e2d\u6587']) {
      const signature = mine.signMessage(message)
      expect(signature).toBe(await theirs.signMessage({ message }))

      const recovered = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`
      })
      expect(recovered).toBe(mine.address)
    }
  })

  it('produces a 65-byte signature ending in a v of 27 or 28', () => {
    const signature = toBytes(mine.signMessage('lightchain'))
    expect(signature.length).toBe(65)
    expect([27, 28]).toContain(signature[64])
  })
})
