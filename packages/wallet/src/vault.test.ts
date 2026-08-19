import { describe, expect, it } from 'vitest'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import {
  ACCOUNT_PATH,
  MAX_ACCOUNT_INDEX,
  VaultError,
  derivePrivateKey,
  generatePhrase,
  isAccountIndex,
  isValidPhrase,
  normalise,
  open,
  seal
} from './index.js'

/**
 * viem is the oracle for derivation, as it was for signing.
 *
 * A phrase that derives a different address than every other wallet would be
 * worse than useless: it would look like a working backup and restore an empty
 * account somewhere else.
 */

// The published Anvil/Hardhat test mnemonic. Public, holds nothing.
const PHRASE = 'test test test test test test test test test test test junk'
const PASSWORD = 'correct horse battery staple'

describe('derivation', () => {
  it('agrees with viem on the first account', () => {
    const ours = privateKeyToAccount(derivePrivateKey(PHRASE, 0) as `0x${string}`)
    expect(ours.address).toBe(mnemonicToAccount(PHRASE).address)
    // And with the address the whole Ethereum world knows for this phrase.
    expect(ours.address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  })

  it('agrees on later accounts too', () => {
    for (const index of [1, 2, 5, 100]) {
      const ours = privateKeyToAccount(derivePrivateKey(PHRASE, index) as `0x${string}`)
      expect(ours.address).toBe(mnemonicToAccount(PHRASE, { addressIndex: index }).address)
    }
  })

  it('uses the path every other wallet uses', () => {
    // Restoring this phrase in MetaMask must land on the same first account.
    expect(ACCOUNT_PATH).toBe("m/44'/60'/0'/0")
  })

  it('refuses an index that is not one', () => {
    expect(() => derivePrivateKey(PHRASE, -1)).toThrow(VaultError)
    expect(() => derivePrivateKey(PHRASE, 1.5)).toThrow(VaultError)
    expect(() => derivePrivateKey(PHRASE, Number.NaN)).toThrow(VaultError)
  })

  it('refuses an index nothing could ever find again', () => {
    // Another wallet restoring this phrase walks forward from zero and gives
    // up after a run of empty accounts, so an account out here is not a high
    // account, it is a lost one. The cap is also what catches a timestamp or a
    // balance arriving where an index was meant to.
    expect(() => derivePrivateKey(PHRASE, MAX_ACCOUNT_INDEX + 1)).toThrow(/between 0 and/)
    expect(() => derivePrivateKey(PHRASE, Date.now())).toThrow(/between 0 and/)

    expect(derivePrivateKey(PHRASE, MAX_ACCOUNT_INDEX)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('says which numbers name an account, so an interface can ask first', () => {
    expect(isAccountIndex(0)).toBe(true)
    expect(isAccountIndex(MAX_ACCOUNT_INDEX)).toBe(true)
    expect(isAccountIndex(-1)).toBe(false)
    expect(isAccountIndex(2.5)).toBe(false)
    expect(isAccountIndex(MAX_ACCOUNT_INDEX + 1)).toBe(false)
  })
})

describe('phrases', () => {
  it('generates twelve valid words', () => {
    const phrase = generatePhrase()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(isValidPhrase(phrase)).toBe(true)
  })

  it('generates a different one each time', () => {
    expect(generatePhrase()).not.toBe(generatePhrase())
  })

  it('rejects a single mistyped word', () => {
    // The BIP-39 checksum is the whole reason a phrase is safe to transcribe by
    // hand: a typo is rejected rather than silently opening another wallet.
    const words = PHRASE.split(' ')
    words[3] = 'zoo'
    expect(isValidPhrase(words.join(' '))).toBe(false)
  })

  it('rejects words in the wrong order', () => {
    const reversed = PHRASE.split(' ').reverse().join(' ')
    expect(isValidPhrase(reversed)).toBe(false)
  })

  it('rejects the wrong number of words', () => {
    expect(isValidPhrase(PHRASE.split(' ').slice(0, 11).join(' '))).toBe(false)
  })

  it('forgives how a person types it', () => {
    // Copied from paper with stray capitals, double spaces and a trailing
    // newline. All of that is presentation, not content.
    const messy = `  Test  TEST test test test test\ntest test test test test JUNK  `
    expect(normalise(messy)).toBe(PHRASE)
    expect(isValidPhrase(messy)).toBe(true)
    expect(derivePrivateKey(messy, 0)).toBe(derivePrivateKey(PHRASE, 0))
  })
})

describe('the vault', () => {
  it('seals and opens', () => {
    const vault = seal(PHRASE, PASSWORD)
    expect(open(vault, PASSWORD)).toBe(PHRASE)
  })

  it('does not contain the phrase in the clear', () => {
    const vault = seal(PHRASE, PASSWORD)
    const serialised = JSON.stringify(vault)
    for (const word of ['test', 'junk']) {
      expect(Buffer.from(serialised).includes(Buffer.from(word))).toBe(false)
    }
  })

  it('produces a different file every time', () => {
    // A fresh salt and nonce per seal. Reusing a GCM nonce under one key is
    // catastrophic, and a fixed salt makes a rainbow table possible.
    const a = seal(PHRASE, PASSWORD)
    const b = seal(PHRASE, PASSWORD)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.kdfparams.salt).not.toBe(b.kdfparams.salt)
    expect(a.iv).not.toBe(b.iv)
  })

  it('refuses a wrong password without saying it was the password', () => {
    const vault = seal(PHRASE, PASSWORD)
    expect(() => open(vault, 'not it')).toThrow(/wrong password, or the vault has been altered/)
  })

  it('detects tampering, because GCM authenticates', () => {
    const vault = seal(PHRASE, PASSWORD)
    expect(() =>
      open({ ...vault, ciphertext: vault.ciphertext.replace(/..$/, '00') }, PASSWORD)
    ).toThrow(VaultError)
    expect(() => open({ ...vault, tag: vault.tag.replace(/..$/, '00') }, PASSWORD)).toThrow(
      VaultError
    )
  })

  it('records its parameters so they can change later', () => {
    // A vault that assumed the parameters could never be raised without
    // orphaning every wallet already written.
    const vault = seal(PHRASE, PASSWORD)
    expect(vault.kdfparams.n).toBe(262_144)
    expect(vault.kdf).toBe('scrypt')
    expect(vault.cipher).toBe('aes-256-gcm')
  })

  it('refuses parameters that would make it fast or unopenable', () => {
    const vault = seal(PHRASE, PASSWORD)
    expect(() => open({ ...vault, kdfparams: { ...vault.kdfparams, n: 1024 } }, PASSWORD)).toThrow(
      /out of range/
    )
    expect(() =>
      open({ ...vault, kdfparams: { ...vault.kdfparams, n: 2 ** 30 } }, PASSWORD)
    ).toThrow(/out of range/)
  })

  it('refuses to seal a phrase that is not one', () => {
    expect(() => seal('not a real phrase at all', PASSWORD)).toThrow(/not a valid recovery phrase/)
    expect(() => seal(PHRASE, 'short')).toThrow(/at least 8 characters/)
  })
})
