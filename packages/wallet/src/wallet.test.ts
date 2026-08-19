import { describe, expect, it } from 'vitest'
import { mnemonicToAccount } from 'viem/accounts'
import {
  Wallet,
  WalletError,
  decrypt,
  deriveKey,
  isValidPhrase,
  memoryVaultStore
} from './index.js'

/**
 * scrypt is half a second per call by design, so these share a wallet where
 * they can. Every create, unlock and reveal below is a real derivation at the
 * parameters that ship.
 */

const PHRASE = 'test test test test test test test test test test test junk'
const PASSWORD = 'correct horse battery staple'

describe('a new wallet', () => {
  const wallet = new Wallet(memoryVaultStore())

  it('starts with nothing', () => {
    expect(wallet.status()).toMatchObject({ exists: false, unlocked: false, address: null })
  })

  it('cannot be unlocked or used before it exists', () => {
    expect(() => wallet.unlock(PASSWORD)).toThrow(/no wallet to unlock/)
    expect(() => wallet.account()).toThrow(/locked/)
    expect(() => wallet.revealPhrase(PASSWORD)).toThrow(/no wallet/)
  })

  it('hands back a phrase exactly once, and opens unlocked', () => {
    const { status, phrase } = wallet.create(PASSWORD)

    expect(isValidPhrase(phrase)).toBe(true)
    expect(phrase.split(' ')).toHaveLength(12)
    expect(status.unlocked).toBe(true)
    expect(status.address).toMatch(/^0x[0-9a-fA-F]{40}$/)

    // The address really is the one that phrase produces anywhere else.
    expect(status.address).toBe(mnemonicToAccount(phrase).address)
  })

  it('tells the caller which path it used, so it can be restored elsewhere', () => {
    expect(wallet.status().path).toBe("m/44'/60'/0'/0/0")
  })

  it('refuses to overwrite itself', () => {
    expect(() => wallet.create('another password entirely')).toThrow(/already exists/)
    expect(() => wallet.importPhrase(PHRASE, PASSWORD)).toThrow(/already exists/)
  })

  it('does not hold the phrase while unlocked', () => {
    // Unlocked means it can sign, not that it can hand over every account
    // derived from the phrase forever.
    const phrase = wallet.revealPhrase(PASSWORD)
    expect(JSON.stringify(wallet)).not.toContain(phrase.split(' ')[0])
    expect(Object.keys(wallet)).toEqual([])
  })

  it('locks and unlocks back to the same address', () => {
    const address = wallet.status().address

    expect(wallet.lock()).toMatchObject({ unlocked: false, address: null })
    expect(() => wallet.account()).toThrow(/locked/)

    expect(wallet.unlock(PASSWORD).address).toBe(address)
  })

  it('refuses the wrong password without saying which part was wrong', () => {
    expect(() => wallet.unlock('nearly right')).toThrow(
      /wrong password, or the vault has been altered/
    )
  })
})

describe('restoring', () => {
  it('takes a phrase and lands on the address every other wallet would', () => {
    const wallet = new Wallet(memoryVaultStore())
    const status = wallet.importPhrase(PHRASE, PASSWORD)

    expect(status.address).toBe(mnemonicToAccount(PHRASE).address)
    expect(status.address?.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  })

  it('accepts a phrase typed the way a person types it', () => {
    const wallet = new Wallet(memoryVaultStore())
    const messy = `  Test  TEST test test test test\ntest test test test test JUNK  `
    expect(wallet.importPhrase(messy, PASSWORD).address).toBe(mnemonicToAccount(PHRASE).address)
  })

  it('rejects a mistyped phrase and says what to look for', () => {
    const wallet = new Wallet(memoryVaultStore())
    const words = PHRASE.split(' ')
    words[5] = 'zoo'

    expect(() => wallet.importPhrase(words.join(' '), PASSWORD)).toThrow(/mistyped or missing word/)
    expect(wallet.status().exists).toBe(false)
  })
})

describe('backing up later', () => {
  const wallet = new Wallet(memoryVaultStore())
  const created = wallet.create(PASSWORD)

  it('reveals the phrase, but only for the password', () => {
    // The wallet is unlocked. Seeing the phrase should still cost what created
    // it rather than proximity to the keyboard.
    expect(wallet.status().unlocked).toBe(true)
    expect(() => wallet.revealPhrase('wrong')).toThrow(/wrong password/)
    expect(wallet.revealPhrase(PASSWORD)).toBe(created.phrase)
  })

  it('exports a keystore any Ethereum tool reads', () => {
    const keystore = wallet.exportKeystore(PASSWORD, 0)
    expect(keystore.version).toBe(3)

    // And it holds this account's key, not the phrase — one account, not all of
    // them, which is the point of exporting a file rather than the words.
    const key = decrypt(keystore, PASSWORD)
    expect(key).toMatch(/^0x[0-9a-f]{64}$/)
    expect(JSON.stringify(keystore)).not.toContain(created.phrase.split(' ')[0])
  })

  it('reports the address of a later account without switching to it', () => {
    const second = wallet.addressAt(PASSWORD, 1)
    expect(second).toBe(mnemonicToAccount(created.phrase, { addressIndex: 1 }).address)
    expect(second).not.toBe(wallet.status().address)
  })

  it('needs the password to remove itself', () => {
    expect(() => wallet.remove('wrong')).toThrow()
    expect(wallet.status().exists).toBe(true)

    expect(wallet.remove(PASSWORD)).toMatchObject({ exists: false, unlocked: false })
  })
})

describe('changing the password', () => {
  it('keeps the phrase, the address, and everything derived from the key', () => {
    const wallet = new Wallet(memoryVaultStore())
    const created = wallet.create(PASSWORD)
    const address = created.status.address
    const derived = deriveKey(wallet.account(), 'transcripts')

    wallet.changePassword(PASSWORD, 'a different password entirely')

    // The password guards the vault; it does not define the identity. Anything
    // sealed under a key derived from the account stays readable.
    expect(wallet.status().address).toBe(address)
    expect(wallet.revealPhrase('a different password entirely')).toBe(created.phrase)
    expect(deriveKey(wallet.account(), 'transcripts')).toEqual(derived)
  })

  it('will not open under the old password afterwards', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)
    wallet.changePassword(PASSWORD, 'the new one')

    wallet.lock()
    expect(() => wallet.unlock(PASSWORD)).toThrow(/wrong password/)
    expect(wallet.unlock('the new one').unlocked).toBe(true)
  })

  it('refuses the wrong current password, and changes nothing', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)

    expect(() => wallet.changePassword('not it', 'something new')).toThrow(/wrong password/)
    expect(wallet.revealPhrase(PASSWORD)).toBeTruthy()
  })

  it('refuses a new password too short to be worth the scrypt', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)

    expect(() => wallet.changePassword(PASSWORD, 'short')).toThrow(/at least 8 characters/)
    // And the old one still works, because nothing was written.
    expect(wallet.revealPhrase(PASSWORD)).toBeTruthy()
  })

  it('refuses to change a password to itself', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)
    expect(() => wallet.changePassword(PASSWORD, PASSWORD)).toThrow(/already has/)
  })

  it('has nothing to change when there is no wallet', () => {
    expect(() => new Wallet(memoryVaultStore()).changePassword(PASSWORD, 'other')).toThrow(
      /no wallet/
    )
  })
})

describe('more than one account', () => {
  const wallet = new Wallet(memoryVaultStore())
  const created = wallet.create(PASSWORD)
  const firstAccountKey = deriveKey(wallet.account(), 'room registry')

  it('starts on the one every other wallet calls the first', () => {
    expect(wallet.status()).toMatchObject({ accountIndex: 0, path: "m/44'/60'/0'/0/0" })
    expect(wallet.status().address).toBe(mnemonicToAccount(created.phrase).address)
  })

  it('switches to another account, and says which one it is on', () => {
    const status = wallet.switchAccount(PASSWORD, 3)

    expect(status).toMatchObject({ unlocked: true, accountIndex: 3, path: "m/44'/60'/0'/0/3" })
    expect(status.address).toBe(mnemonicToAccount(created.phrase, { addressIndex: 3 }).address)
  })

  it('takes every derived key with it, and brings them back on the way home', () => {
    // The surprising part, and the reason switching says so in its own
    // documentation: rooms and transcripts are sealed under a signature by
    // whichever account is active, so a switch hides them rather than carrying
    // them across. Nothing is lost, which is what the second half proves.
    expect(deriveKey(wallet.account(), 'room registry')).not.toEqual(firstAccountKey)

    wallet.switchAccount(PASSWORD, 0)
    expect(deriveKey(wallet.account(), 'room registry')).toEqual(firstAccountKey)
  })

  it('refuses an index that is not one, and stays where it was', () => {
    for (const index of [-1, 1.5, Number.NaN, 1_000_000]) {
      expect(() => wallet.switchAccount(PASSWORD, index)).toThrow(WalletError)
      expect(() => wallet.unlock(PASSWORD, index)).toThrow(/between 0 and/)
    }

    expect(wallet.status()).toMatchObject({ accountIndex: 0, unlocked: true })
  })

  it('does not move on a wrong password', () => {
    expect(() => wallet.switchAccount('nearly right', 1)).toThrow(/wrong password/)
    expect(wallet.status().address).toBe(mnemonicToAccount(created.phrase).address)
  })

  it('unlocks straight into a chosen account', () => {
    wallet.lock()
    const status = wallet.unlock(PASSWORD, 2)

    expect(status.accountIndex).toBe(2)
    expect(status.address).toBe(mnemonicToAccount(created.phrase, { addressIndex: 2 }).address)
  })

  it('forgets which account it was on when it locks', () => {
    // There is nowhere to remember it that survives a restart, so remembering
    // it here would mean coming back to account two this afternoon and to
    // account zero tomorrow — with a different set of rooms each time.
    expect(wallet.lock()).toMatchObject({ accountIndex: 0, path: "m/44'/60'/0'/0/0" })
    expect(wallet.unlock(PASSWORD).address).toBe(mnemonicToAccount(created.phrase).address)
  })
})

describe('passwords', () => {
  it('must be long enough for the derivation cost to matter', () => {
    const wallet = new Wallet(memoryVaultStore())
    expect(() => wallet.create('short')).toThrow(/at least 8 characters/)
    expect(wallet.status().exists).toBe(false)
  })
})

describe('signing', () => {
  it('signs with the derived account', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.importPhrase(PHRASE, PASSWORD)
    expect(wallet.signMessage('lightchain')).toHaveLength(132)
    expect(() => new Wallet(memoryVaultStore()).signMessage('x')).toThrow(WalletError)
  })
})
