import { describe, expect, it } from 'vitest'
import { fromPrivateKey } from '@lcai-p2p/chain'
import { DerivedKeyError, deriveKey, openData, openJson, sealData, sealJson } from './index.js'

// Anvil's first two keys. Public, hold nothing.
const account = fromPrivateKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const other = fromPrivateKey('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

describe('deriving a key', () => {
  it('is the same key every time for one account and purpose', () => {
    // Anything else and the data written yesterday cannot be read today.
    expect(deriveKey(account, 'rooms')).toEqual(deriveKey(account, 'rooms'))
  })

  it('is a different key for a different purpose', () => {
    // Sharing one key across two files makes a flaw in either expose both, and
    // makes nonce reuse across them a real possibility.
    expect(deriveKey(account, 'rooms')).not.toEqual(deriveKey(account, 'transcripts'))
  })

  it('is a different key for a different wallet', () => {
    expect(deriveKey(account, 'rooms')).not.toEqual(deriveKey(other, 'rooms'))
  })

  it('is 32 bytes', () => {
    expect(deriveKey(account, 'rooms')).toHaveLength(32)
  })

  it('refuses a purpose that is not one', () => {
    expect(() => deriveKey(account, '')).toThrow(DerivedKeyError)
    expect(() => deriveKey(account, '   ')).toThrow(DerivedKeyError)
  })
})

describe('sealing data', () => {
  const key = deriveKey(account, 'rooms')

  it('round trips', () => {
    const secret = new TextEncoder().encode('a room encryption key')
    expect(openData(key, sealData(key, secret))).toEqual(secret)
  })

  it('round trips json', () => {
    const rooms = [{ key: 'a'.repeat(64), encryptionKey: 'b'.repeat(64) }]
    expect(openJson(key, sealJson(key, rooms))).toEqual(rooms)
  })

  it('does not leave the content in the clear', () => {
    const sealed = sealData(key, new TextEncoder().encode('a room encryption key'))
    expect(Buffer.from(sealed).includes(Buffer.from('room'))).toBe(false)
  })

  it('produces different bytes each time', () => {
    // A fresh nonce per seal. Reusing one under the same key is catastrophic
    // for GCM, and a registry is rewritten on every change.
    const value = new TextEncoder().encode('same input')
    expect(sealData(key, value)).not.toEqual(sealData(key, value))
  })

  it('will not open under another wallet', () => {
    const sealed = sealData(key, new TextEncoder().encode('mine'))
    expect(() => openData(deriveKey(other, 'rooms'), sealed)).toThrow(/wrong key/)
  })

  it('will not open under another purpose', () => {
    const sealed = sealData(key, new TextEncoder().encode('mine'))
    expect(() => openData(deriveKey(account, 'transcripts'), sealed)).toThrow(/wrong key/)
  })

  it('detects tampering, because GCM authenticates', () => {
    const sealed = sealData(key, new TextEncoder().encode('untouched'))
    const altered = new Uint8Array(sealed)
    altered[20] = (altered[20] as number) ^ 0xff
    expect(() => openData(key, altered)).toThrow(/altered/)
  })

  it('refuses something too short to be sealed data', () => {
    expect(() => openData(key, new Uint8Array(8))).toThrow(/too short/)
  })

  it('refuses a key of the wrong size', () => {
    expect(() => sealData(new Uint8Array(16), new Uint8Array(1))).toThrow(/32 bytes/)
    expect(() => openData(new Uint8Array(16), new Uint8Array(40))).toThrow(/32 bytes/)
  })
})
