import { describe, expect, it } from 'vitest'
import { hashMessage, recoverMessageAddress, verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  fromPrivateKey,
  hashDigestForSigning,
  keccak256,
  recoverAddress,
  toBytes,
  toHex
} from './index.js'

/**
 * viem is the oracle for recovery as it was for signing, because a verifier
 * that is subtly wrong is worse than none: it recovers a real-looking address
 * that never matches, and every honest answer gets rejected.
 */

// Anvil's first key. Public, holds nothing.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = fromPrivateKey(KEY)
const viemAccount = privateKeyToAccount(KEY)

describe('recovering a signer', () => {
  it('agrees with viem on a message this signed', async () => {
    for (const message of ['', 'lightchain', 'a'.repeat(500), 'unicode ✓ ☃']) {
      const signature = account.signMessage(message)
      expect(await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toBe(
        account.address
      )
      // And our own recovery agrees with viem's hashing of the same message.
      expect(recoverAddress(toBytes(hashMessage(message)), signature)).toBe(account.address)
    }
  })

  it('recovers what viem signed', async () => {
    const message = 'signed elsewhere'
    const signature = await viemAccount.signMessage({ message })
    expect(recoverAddress(toBytes(hashMessage(message)), signature)).toBe(viemAccount.address)
    expect(
      await verifyMessage({ address: account.address as `0x${string}`, message, signature })
    ).toBe(true)
  })

  it('accepts a recovery byte in either convention', () => {
    // Ethereum says 27 or 28; secp256k1 says 0 or 1. The workers emit 0/1 and
    // contracts want 27/28, so a verifier meeting both has to take either.
    const message = 'either way'
    const signature = toBytes(account.signMessage(message))
    const digest = toBytes(hashMessage(message))

    const asEthereum = new Uint8Array(signature)
    const asRaw = new Uint8Array(signature)
    asRaw[64] = (asRaw[64] as number) - 27

    expect(recoverAddress(digest, toHex(asEthereum))).toBe(account.address)
    expect(recoverAddress(digest, toHex(asRaw))).toBe(account.address)
  })

  it('recovers a different address from a tampered digest', () => {
    // The point of verifying: a substituted payload must not recover the signer.
    const signature = account.signMessage('the real answer')
    const wrong = toBytes(hashMessage('a substituted answer'))
    expect(recoverAddress(wrong, signature)).not.toBe(account.address)
  })

  it('refuses a signature that is not one', () => {
    const digest = toBytes(hashMessage('x'))
    expect(() => recoverAddress(digest, '0x1234')).toThrow(/65 bytes/)
    expect(() => recoverAddress(digest, '0x' + 'aa'.repeat(64) + '07')).toThrow(/recovery byte/)
  })
})

describe('the digest prefix', () => {
  it('matches what a contract computes before ecrecover', () => {
    // keccak256("\x19Ethereum Signed Message:\n32" || hash), with a literal 32
    // because the length is of the digest, not of any text.
    const inner = keccak256(new TextEncoder().encode('anything'))
    const ours = hashDigestForSigning(inner)

    // viem hashes raw bytes the same way when given them as a byte message.
    expect(toHex(ours)).toBe(hashMessage({ raw: toHex(inner) as `0x${string}` }))
  })

  it('refuses anything that is not 32 bytes', () => {
    expect(() => hashDigestForSigning(new Uint8Array(31))).toThrow(/32-byte digest/)
  })
})
