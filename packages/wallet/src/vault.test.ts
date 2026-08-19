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

/**
 * Changes the last byte of a hex string, whatever it happens to be.
 *
 * Overwriting it with a fixed value instead is a no-op roughly one time in 256
 * — precisely when the byte already holds that value — and the salt and nonce
 * are random, so the tamper tests below quietly passed on an untouched vault at
 * about that rate. Flipping the low bit always changes something.
 */
function flipLastByte(hex: string): string {
  const last = Number.parseInt(hex.slice(-2), 16)
  return hex.slice(0, -2) + (last ^ 1).toString(16).padStart(2, '0')
}

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
    expect(open(vault, PASSWORD)).toEqual({ phrase: PHRASE, passphrase: '' })
  })

  it('stays version 1 when there is no passphrase, so older builds can still read it', () => {
    expect(seal(PHRASE, PASSWORD).version).toBe(1)
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
    expect(() => open({ ...vault, ciphertext: flipLastByte(vault.ciphertext) }, PASSWORD)).toThrow(
      VaultError
    )
    expect(() => open({ ...vault, tag: flipLastByte(vault.tag) }, PASSWORD)).toThrow(VaultError)
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

describe("BIP-39's 25th word", () => {
  const EXTRA = 'a Passphrase With Caps'

  it('is carried through a seal and back', () => {
    const vault = seal(PHRASE, PASSWORD, EXTRA)
    expect(vault.version).toBe(2)
    expect(open(vault, PASSWORD)).toEqual({ phrase: PHRASE, passphrase: EXTRA })
  })

  it('is not in the file in the clear', () => {
    const serialised = JSON.stringify(seal(PHRASE, PASSWORD, EXTRA))
    expect(serialised.includes('Passphrase')).toBe(false)
    expect(serialised.includes('passphrase')).toBe(false)
  })

  it('derives a different wallet, which is the whole point', () => {
    expect(derivePrivateKey(PHRASE, 0, EXTRA)).not.toBe(derivePrivateKey(PHRASE, 0))
  })

  it('agrees with viem, so a wallet made elsewhere restores here', () => {
    const ours = privateKeyToAccount(derivePrivateKey(PHRASE, 0, EXTRA) as `0x${string}`)
    expect(ours.address).toBe(mnemonicToAccount(PHRASE, { passphrase: EXTRA }).address)
  })

  it('is case and space sensitive, unlike the phrase', () => {
    // `normalise` must never touch it. Lowercasing a passphrase would derive a
    // different wallet from the one it was written for, silently.
    expect(derivePrivateKey(PHRASE, 0, EXTRA)).not.toBe(
      derivePrivateKey(PHRASE, 0, EXTRA.toLowerCase())
    )
    expect(derivePrivateKey(PHRASE, 0, ' x')).not.toBe(derivePrivateKey(PHRASE, 0, 'x'))
  })

  it('treats an empty one as none at all', () => {
    expect(derivePrivateKey(PHRASE, 0, '')).toBe(derivePrivateKey(PHRASE, 0))
    expect(seal(PHRASE, PASSWORD, '').version).toBe(1)
  })

  it('still refuses a wrong password', () => {
    const vault = seal(PHRASE, PASSWORD, EXTRA)
    expect(() => open(vault, 'not it')).toThrow(/wrong password/)
  })

  it('reports a version 2 payload that is not JSON as a bad vault', () => {
    // Reachable only if this code wrote something it can no longer read. The
    // bytes authenticated, so it is not an attacker, and the shape of the
    // failure is not something a user can act on.
    const v1 = seal(PHRASE, PASSWORD)
    expect(() => open({ ...v1, version: 2 }, PASSWORD)).toThrow(/readable phrase/)
  })

  it('refuses a version it does not know', () => {
    const vault = seal(PHRASE, PASSWORD)
    expect(() => open({ ...vault, version: 3 }, PASSWORD)).toThrow(/unsupported vault version/)
  })
})
