import { describe, expect, it } from 'vitest'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import {
  AUTO_LOCK_OFF,
  DEFAULT_AUTO_LOCK_MS,
  REPLACE_CONFIRMATION,
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
    expect(() => wallet.remove({ password: 'wrong' })).toThrow()
    expect(wallet.status().exists).toBe(true)

    expect(wallet.remove({ password: PASSWORD })).toMatchObject({ exists: false, unlocked: false })
  })
})

/**
 * The situation all of this exists for: a vault on the disk, a password nobody
 * has, and an unlock screen that is the only thing on offer. Every refusal
 * below is calibrated against that — strict enough to be worth asking, and
 * never so strict that the answer is "this machine is finished".
 */
describe('replacing a wallet nobody can unlock', () => {
  it('removes on the confirmation alone, with no password anywhere', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)

    expect(wallet.remove({ confirmation: REPLACE_CONFIRMATION })).toMatchObject({
      exists: false,
      unlocked: false,
      address: null
    })
  })

  it('refuses anything that is not that word, exactly, and keeps the wallet', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)

    // Deliberately neither trimmed nor case-folded. ` REPLACE ` is what a paste
    // produces and `replace` is what a hurry produces; somebody reading the
    // sentence and typing the word produces neither, and pays nothing for the
    // strictness.
    for (const confirmation of [
      undefined,
      '',
      'replace',
      'Replace',
      ' REPLACE',
      'REPLACE ',
      ' REPLACE ',
      'REPLACE!'
    ]) {
      expect(() => wallet.remove({ confirmation })).toThrow(/typed exactly as it is written here/)
    }

    expect(() => wallet.remove()).toThrow(WalletError)
    expect(wallet.status().exists).toBe(true)
  })

  it('holds a caller to a password it offered rather than dropping to the weaker proof', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)

    // A screen asking for the word sends the word and nothing else. One that
    // sends a wrong password beside it is claiming ownership and failing, and
    // being told so beats succeeding by the back door.
    expect(() =>
      wallet.remove({ password: 'nearly right', confirmation: REPLACE_CONFIRMATION })
    ).toThrow(/wrong password/)
    expect(wallet.status().exists).toBe(true)

    expect(wallet.remove({ password: PASSWORD, confirmation: 'nonsense' }).exists).toBe(false)
  })
})

describe('replacing what is already here', () => {
  const wallet = new Wallet(memoryVaultStore())
  const first = wallet.create(PASSWORD)

  it('says nothing was replaced when there was nothing to replace', () => {
    expect(first.status.replaced).toBe(false)
  })

  it('still refuses in the words it always used when nobody confirmed', () => {
    expect(() => wallet.create('another password entirely')).toThrow(
      'a wallet already exists. Remove it deliberately before creating another.'
    )
    expect(() => wallet.importPhrase(PHRASE, PASSWORD)).toThrow(
      'a wallet already exists. Remove it deliberately before importing another.'
    )

    // A near miss is not a confirmation, and says so in the same words: there
    // is nothing to be gained by telling somebody how close they were.
    expect(() => wallet.create(PASSWORD, { confirmation: 'replace' })).toThrow(/already exists/)
    expect(wallet.revealPhrase(PASSWORD)).toBe(first.phrase)
  })

  it('creates over it on the confirmation, and reports that it did', () => {
    const second = wallet.create(PASSWORD, { confirmation: REPLACE_CONFIRMATION })

    expect(second.status.replaced).toBe(true)
    expect(second.phrase).not.toBe(first.phrase)
    expect(second.status.address).toBe(mnemonicToAccount(second.phrase).address)

    // The old phrase is gone rather than shadowed. Nothing left here opens it.
    expect(wallet.revealPhrase(PASSWORD)).toBe(second.phrase)
  })

  it('imports over it, landing on the address that phrase names anywhere', () => {
    const status = wallet.importPhrase(PHRASE, PASSWORD, { confirmation: REPLACE_CONFIRMATION })

    expect(status.replaced).toBe(true)
    expect(status.address).toBe(mnemonicToAccount(PHRASE).address)
  })

  it('leaves the wallet it could not replace exactly as it was', () => {
    // Everything that can fail is checked before anything is written, because a
    // replacement that gets half way has destroyed a phrase and put nothing in
    // its place.
    const address = wallet.status().address

    expect(() => wallet.create('short', { confirmation: REPLACE_CONFIRMATION })).toThrow(
      /at least 8 characters/
    )
    expect(() =>
      wallet.importPhrase('not twelve words at all', PASSWORD, {
        confirmation: REPLACE_CONFIRMATION
      })
    ).toThrow(/mistyped or missing word/)

    expect(wallet.status().address).toBe(address)
    expect(wallet.revealPhrase(PASSWORD)).toBe(PHRASE)
  })
})

describe('coming back after a replacement', () => {
  it('restores the same identity, and every key derived from it', () => {
    // This is the claim an interface is allowed to make on the confirmation
    // screen. Room registries and sealed documents are held under keys derived
    // from the account, and they are left on disk — so the same phrase typed
    // back opens exactly what it opened before, and "your rooms come back" is
    // a statement of fact rather than a hope.
    const wallet = new Wallet(memoryVaultStore())
    const before = wallet.importPhrase(PHRASE, PASSWORD)
    const registryKey = deriveKey(wallet.account(), 'room registry')

    const between = wallet.create(PASSWORD, { confirmation: REPLACE_CONFIRMATION })
    expect(between.status.address).not.toBe(before.address)
    expect(deriveKey(wallet.account(), 'room registry')).not.toEqual(registryKey)

    const after = wallet.importPhrase(PHRASE, 'a different password entirely', {
      confirmation: REPLACE_CONFIRMATION
    })

    expect(after.address).toBe(before.address)
    expect(deriveKey(wallet.account(), 'room registry')).toEqual(registryKey)
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

  it('lists its accounts without a password, and gets the same addresses', () => {
    // The whole point of holding the account-level public key: an open wallet
    // can name every account it has without reopening the vault. If these ever
    // disagreed with the private derivation, the switcher would offer addresses
    // that belong to nobody and switching to one would land somewhere else.
    const listed = wallet.addresses(5)

    expect(listed).toHaveLength(5)
    for (const { index, address } of listed) {
      expect(address).toBe(mnemonicToAccount(created.phrase, { addressIndex: index }).address)
    }
  })

  it('refuses to list them once locked', () => {
    // The addresses are not a secret the way the phrase is, but they are a
    // record of what this person holds, and a locked wallet answers nothing.
    wallet.lock()
    expect(() => wallet.addresses(5)).toThrow(/locked/)
    wallet.unlock(PASSWORD)
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

describe('locking itself when nobody is there', () => {
  // The clock is an argument rather than a timer, so these are exact rather
  // than slow. A real caller passes `Date.now()` from a poll loop.
  const minutes = (n: number) => n * 60 * 1000

  function unlocked(autoLockMs = DEFAULT_AUTO_LOCK_MS) {
    const wallet = new Wallet(memoryVaultStore(), { autoLockMs })
    wallet.create(PASSWORD)
    return wallet
  }

  it('defaults to fifteen minutes and reports how long it has been idle', () => {
    const wallet = unlocked()
    expect(wallet.status(0).autoLockMs).toBe(minutes(15))
    expect(wallet.status(0).idleMs).toBe(0)
  })

  it('stays open right up to the timeout and locks the moment it passes', () => {
    const wallet = unlocked(minutes(15))
    wallet.touch(0)

    expect(wallet.lockIfIdle(minutes(14))).toBe(false)
    expect(wallet.status().unlocked).toBe(true)

    expect(wallet.lockIfIdle(minutes(15))).toBe(true)
    expect(wallet.status().unlocked).toBe(false)
  })

  it('says nothing happened when it was already locked', () => {
    const wallet = unlocked(minutes(1))
    wallet.lock()
    expect(wallet.lockIfIdle(minutes(600))).toBe(false)
  })

  it('counts using the key as being present', () => {
    const wallet = unlocked(minutes(15))
    wallet.touch(0)

    wallet.account(minutes(14))
    expect(wallet.lockIfIdle(minutes(20))).toBe(false)
    expect(wallet.lockIfIdle(minutes(29.1))).toBe(true)
  })

  it('counts a touch as being present, without needing the key', () => {
    const wallet = unlocked(minutes(10))
    wallet.touch(0)
    wallet.touch(minutes(9))
    expect(wallet.lockIfIdle(minutes(18))).toBe(false)
  })

  it('never locks when it is switched off', () => {
    const wallet = unlocked(AUTO_LOCK_OFF)
    wallet.touch(0)
    expect(wallet.lockIfIdle(minutes(60 * 24 * 365))).toBe(false)
  })

  it('restarts the clock when the timeout changes, rather than locking on the spot', () => {
    // Shortening the timeout below the time already spent idle would otherwise
    // lock immediately, which reads as the setting having broken something.
    const wallet = unlocked(minutes(60))
    wallet.touch(0)

    wallet.setAutoLock(minutes(5), minutes(30))
    expect(wallet.lockIfIdle(minutes(31))).toBe(false)
    expect(wallet.lockIfIdle(minutes(35))).toBe(true)
  })

  it('refuses a timeout that is not a length of time', () => {
    const wallet = unlocked()
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wallet.setAutoLock(bad)).toThrow(WalletError)
    }
  })

  it('has no idle time to report while locked', () => {
    expect(new Wallet(memoryVaultStore()).status().idleMs).toBe(null)
  })
})

describe('proving somebody is present', () => {
  it('accepts the password and refuses anything else', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.create(PASSWORD)

    expect(wallet.verifyPassword(PASSWORD)).toBe(true)
    expect(wallet.verifyPassword('nearly right')).toBe(false)
    expect(wallet.verifyPassword('')).toBe(false)
  })

  it('leaves the wallet exactly as it found it', () => {
    const wallet = new Wallet(memoryVaultStore())
    const created = wallet.create(PASSWORD)
    wallet.switchAccount(PASSWORD, 2)

    wallet.verifyPassword('wrong')
    expect(wallet.status()).toMatchObject({ unlocked: true, accountIndex: 2 })
    expect(wallet.status().address).toBe(
      mnemonicToAccount(created.phrase, { addressIndex: 2 }).address
    )
  })

  it('counts as presence, so checking it holds off the lock', () => {
    const wallet = new Wallet(memoryVaultStore(), { autoLockMs: 1000 })
    wallet.create(PASSWORD)
    wallet.touch(0)

    wallet.verifyPassword(PASSWORD, 900)
    expect(wallet.lockIfIdle(1500)).toBe(false)
  })

  it('has nothing to check when there is no wallet', () => {
    expect(() => new Wallet(memoryVaultStore()).verifyPassword(PASSWORD)).toThrow(/no wallet/)
  })
})

describe('importing a phrase that has a passphrase', () => {
  const EXTRA = 'a Passphrase With Caps'

  it('derives the wallet that passphrase makes, not the bare one', () => {
    const wallet = new Wallet(memoryVaultStore())
    const status = wallet.importPhrase(PHRASE, PASSWORD, { passphrase: EXTRA })

    expect(status.address).toBe(mnemonicToAccount(PHRASE, { passphrase: EXTRA }).address)
    expect(status.address).not.toBe(mnemonicToAccount(PHRASE).address)
  })

  it('says one exists without ever saying what it is', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.importPhrase(PHRASE, PASSWORD, { passphrase: EXTRA })

    expect(wallet.status().hasPassphrase).toBe(true)
    expect(JSON.stringify(wallet.status()).includes('With Caps')).toBe(false)
  })

  it('survives a lock and unlock', () => {
    const wallet = new Wallet(memoryVaultStore())
    const address = wallet.importPhrase(PHRASE, PASSWORD, { passphrase: EXTRA }).address

    wallet.lock()
    expect(wallet.status().hasPassphrase).toBe(false)
    expect(wallet.unlock(PASSWORD).address).toBe(address)
    expect(wallet.status().hasPassphrase).toBe(true)
  })

  it('survives a password change, which would otherwise empty the wallet', () => {
    const wallet = new Wallet(memoryVaultStore())
    const address = wallet.importPhrase(PHRASE, PASSWORD, { passphrase: EXTRA }).address

    wallet.changePassword(PASSWORD, 'a different password')
    wallet.lock()

    expect(wallet.unlock('a different password').address).toBe(address)
    expect(wallet.revealSecret('a different password').passphrase).toBe(EXTRA)
  })

  it('follows the phrase into other accounts and exports', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.importPhrase(PHRASE, PASSWORD, { passphrase: EXTRA })

    expect(wallet.addressAt(PASSWORD, 4)).toBe(
      mnemonicToAccount(PHRASE, { passphrase: EXTRA, addressIndex: 4 }).address
    )
    expect(wallet.switchAccount(PASSWORD, 4).address).toBe(
      mnemonicToAccount(PHRASE, { passphrase: EXTRA, addressIndex: 4 }).address
    )

    const key = decrypt(wallet.exportKeystore(PASSWORD, 4), PASSWORD)
    expect(privateKeyToAccount(key as `0x${string}`).address).toBe(
      mnemonicToAccount(PHRASE, { passphrase: EXTRA, addressIndex: 4 }).address
    )
  })

  it('reveals the phrase alone, and the passphrase only when asked for both', () => {
    const wallet = new Wallet(memoryVaultStore())
    wallet.importPhrase(PHRASE, PASSWORD, { passphrase: EXTRA })

    expect(wallet.revealPhrase(PASSWORD)).toBe(PHRASE)
    expect(wallet.revealSecret(PASSWORD)).toEqual({ phrase: PHRASE, passphrase: EXTRA })
  })

  it('treats an empty passphrase as the ordinary case', () => {
    const wallet = new Wallet(memoryVaultStore())
    const status = wallet.importPhrase(PHRASE, PASSWORD, { passphrase: '' })

    expect(status.address).toBe(mnemonicToAccount(PHRASE).address)
    expect(status.hasPassphrase).toBe(false)
  })
})
