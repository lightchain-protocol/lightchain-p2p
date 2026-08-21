import { describe, expect, it } from 'vitest'
import {
  DOMAIN_DEPOSIT,
  buildDeposit,
  depositDataRoot,
  depositDomain,
  depositMessageRoot,
  fromHex,
  signingRoot,
  toHex,
  withdrawalCredentials
} from './deposit.js'
import { seedFromPhrase, verify } from './keys.js'

/**
 * A deposit that actually activated a validator on Lightchain mainnet.
 *
 * Pinned from the chain — `DepositEvent` in block 0x16b416, transaction
 * 0xf90f18…3446 — because the EIP-2333 vectors prove the key tree and say
 * nothing about the three things that come after it: the signing domain, the
 * SSZ roots, and which BLS suite the chain signs under. Each of those fails
 * silently. A wrong domain produces a well-formed signature over the wrong
 * message; the contract accepts the deposit, the beacon chain ignores it, and
 * 500,000 LCAI is gone with nothing to look at.
 *
 * Verifying a real one closes all three at once: if this implementation agrees
 * with a deposit the chain accepted, it would have produced an acceptable one.
 */
const REAL = {
  pubkey:
    '0x87d4413809ee0fdd765608413cf6c3495c11b20660ba2cb6bb52bbd479fcb69c641a2a82e1a219e1627ed042e014388d',
  withdrawalCredentials: '0x0100000000000000000000003c6d8caaf07dc37411b05be892081b9a09f4fd5e',
  signature:
    '0xb3d831eb11a22a831a8cfc1ea0b62fd501b559a5d5e0b4ed245985dc40ed7bb57e40285f776e6a01a0f60281d30d697f0b920a3eb1725bed2f634a749c21d7505055a00358dce09d2185913c38019776185b2656cdbc92c88380b8b0f0730c81',
  amountGwei: 500_000_000_000_000n
}

/** Lightchain mainnet's, from the beacon chain's own `/eth/v1/config/spec`. */
const GENESIS_FORK_VERSION = '0x10000089'

describe('a real mainnet deposit', () => {
  it('verifies under the domain and roots this package computes', () => {
    const domain = depositDomain(fromHex(GENESIS_FORK_VERSION))

    const root = signingRoot(
      depositMessageRoot({
        pubkey: fromHex(REAL.pubkey),
        withdrawalCredentials: fromHex(REAL.withdrawalCredentials),
        amount: REAL.amountGwei
      }),
      domain
    )

    expect(verify(fromHex(REAL.signature), root, fromHex(REAL.pubkey))).toBe(true)
  })

  it('does not verify under a fork version copied from another chain', () => {
    // The mistake this pins down: a fork version copied from another chain is
    // four bytes that nothing validates and everything depends on.
    const wrong = depositDomain(fromHex('0x00000000'))
    const root = signingRoot(
      depositMessageRoot({
        pubkey: fromHex(REAL.pubkey),
        withdrawalCredentials: fromHex(REAL.withdrawalCredentials),
        amount: REAL.amountGwei
      }),
      wrong
    )

    expect(verify(fromHex(REAL.signature), root, fromHex(REAL.pubkey))).toBe(false)
  })

  it('stakes what this network asks and withdraws to an ordinary address', () => {
    // 500,000 LCAI, and `0x01` credentials — which is what real operators on
    // this chain are using, and why that is the form built below.
    expect(REAL.amountGwei / 1_000_000_000n).toBe(500_000n)
    expect(REAL.withdrawalCredentials.slice(0, 4)).toBe('0x01')
  })
})

describe('the deposit domain', () => {
  it('is the deposit type followed by 28 bytes of fork data', () => {
    const domain = depositDomain(fromHex(GENESIS_FORK_VERSION))
    expect(domain.length).toBe(32)
    expect([...domain.subarray(0, 4)]).toEqual([...DOMAIN_DEPOSIT])
  })

  it('refuses a fork version that is not four bytes', () => {
    expect(() => depositDomain(new Uint8Array(3))).toThrow(/4 bytes/)
  })
})

describe('withdrawal credentials', () => {
  it('are the 0x01 form: a prefix, eleven zeros, then the address', () => {
    const credentials = withdrawalCredentials('0x3c6d8caaf07dc37411b05be892081b9a09f4fd5e')
    expect(toHex(credentials)).toBe(REAL.withdrawalCredentials)
  })

  it('refuse anything that is not a 20-byte address', () => {
    expect(() => withdrawalCredentials('0x1234')).toThrow(/20-byte address/)
  })
})

describe('building a deposit', () => {
  // The all-zero-entropy 24-word phrase. A phrase with a bad checksum is
  // refused before it derives anything, which is the point of refusing it.
  const phrase = `${'abandon '.repeat(23)}art`
  const withdrawal = '0x3c6d8caaf07dc37411b05be892081b9a09f4fd5e'

  it('signs something that verifies against the key it advertises', () => {
    const deposit = buildDeposit({
      seed: seedFromPhrase(phrase),
      index: 0,
      withdrawalAddress: withdrawal,
      amountGwei: REAL.amountGwei,
      forkVersion: fromHex(GENESIS_FORK_VERSION)
    })

    expect(deposit.pubkey).toMatch(/^0x[0-9a-f]{96}$/)
    expect(deposit.signature).toMatch(/^0x[0-9a-f]{192}$/)
    expect(deposit.depositDataRoot).toMatch(/^0x[0-9a-f]{64}$/)

    const root = signingRoot(
      depositMessageRoot({
        pubkey: fromHex(deposit.pubkey),
        withdrawalCredentials: fromHex(deposit.withdrawalCredentials),
        amount: deposit.amount
      }),
      depositDomain(fromHex(GENESIS_FORK_VERSION))
    )
    expect(verify(fromHex(deposit.signature), root, fromHex(deposit.pubkey))).toBe(true)
  })

  it('gives a different key at every index, from the one phrase', () => {
    const seed = seedFromPhrase(phrase)
    const keys = [0, 1, 2].map(
      (index) =>
        buildDeposit({
          seed,
          index,
          withdrawalAddress: withdrawal,
          amountGwei: REAL.amountGwei,
          forkVersion: fromHex(GENESIS_FORK_VERSION)
        }).pubkey
    )
    expect(new Set(keys).size).toBe(3)
  })

  it('is deterministic, so the same phrase recovers the same validator', () => {
    const build = () =>
      buildDeposit({
        seed: seedFromPhrase(phrase),
        index: 7,
        withdrawalAddress: withdrawal,
        amountGwei: REAL.amountGwei,
        forkVersion: fromHex(GENESIS_FORK_VERSION)
      })
    expect(build()).toEqual(build())
  })

  it('refuses a phrase whose checksum does not hold', () => {
    // A mistyped word is the ordinary way this goes wrong, and deriving from
    // one produces a valid key for a phrase nobody wrote down.
    expect(() => seedFromPhrase(`${'abandon '.repeat(23)}zoo`)).toThrow(/not a valid recovery/)
  })

  it('changes the data root when the amount changes', () => {
    // The root is what the contract checks the rest of the call against, so it
    // has to move when any part of the message does.
    const message = {
      pubkey: fromHex(REAL.pubkey),
      withdrawalCredentials: fromHex(REAL.withdrawalCredentials),
      amount: REAL.amountGwei
    }
    const signature = fromHex(REAL.signature)
    const a = toHex(depositDataRoot(message, signature))
    const b = toHex(depositDataRoot({ ...message, amount: REAL.amountGwei + 1n }, signature))
    expect(a).not.toBe(b)
  })
})
