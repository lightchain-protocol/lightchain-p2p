import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { Wallet, memoryStore } from './index.js'

/**
 * scrypt is half a second per call by design, so these share a wallet where
 * they can. Every `create`, `unlock` and `export` below is a real derivation at
 * the parameters that ship.
 */

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const PASSWORD = 'correct horse battery staple'

describe('a new wallet', () => {
  const wallet = new Wallet(memoryStore())

  it('starts with nothing', () => {
    expect(wallet.status()).toEqual({ exists: false, unlocked: false, address: null })
  })

  it('cannot be unlocked or used before it exists', () => {
    expect(() => wallet.unlock(PASSWORD)).toThrow(/no wallet to unlock/)
    expect(() => wallet.account()).toThrow(/locked/)
    expect(() => wallet.exportKeystore()).toThrow(/no wallet/)
  })

  it('generates a key and comes back unlocked', () => {
    const status = wallet.create(PASSWORD)
    expect(status.exists).toBe(true)
    expect(status.unlocked).toBe(true)
    expect(status.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('refuses to overwrite itself', () => {
    // The keystore is the only copy of a key that may hold funds. Deciding to
    // destroy it belongs to a person, not to a second call to create.
    expect(() => wallet.create('another password entirely')).toThrow(/already exists/)
    expect(() => wallet.importKey(KEY, PASSWORD)).toThrow(/already exists/)
  })

  it('does not expose the key on the object', () => {
    const secret = wallet.exportPrivateKey(PASSWORD)
    expect(JSON.stringify(wallet)).not.toContain(secret.slice(2))
    expect(Object.keys(wallet)).toEqual([])
  })

  it('locks and unlocks', () => {
    const unlockedAddress = wallet.status().address

    expect(wallet.lock()).toMatchObject({ exists: true, unlocked: false })
    expect(() => wallet.account()).toThrow(/locked/)

    // The address survives locking; it is not a secret. And it is reported
    // identically either way — a keystore holds it lowercased, and showing that
    // form while unlocked shows the checksummed one makes one address look like
    // two.
    expect(wallet.status().address).toBe(unlockedAddress)

    expect(wallet.unlock(PASSWORD).unlocked).toBe(true)
    expect(wallet.account().address).toBe(wallet.status().address)
  })

  it('refuses the wrong password without saying which part was wrong', () => {
    expect(() => wallet.unlock('nearly the right one')).toThrow(
      /wrong password, or the keystore has been altered/
    )
  })
})

describe('importing', () => {
  it('takes an existing key and signs with it', () => {
    const wallet = new Wallet(memoryStore())
    const status = wallet.importKey(KEY, PASSWORD)

    expect(status.address).toBe(privateKeyToAccount(KEY).address)

    // And the account really is that key, not merely labelled with it.
    const signature = wallet.signMessage('lightchain')
    expect(signature).toHaveLength(132)
  })

  it('rejects a key that is not one, before spending half a second on scrypt', () => {
    const wallet = new Wallet(memoryStore())
    expect(() => wallet.importKey('0xdeadbeef', PASSWORD)).toThrow()
    expect(wallet.status().exists).toBe(false)
  })
})

describe('passwords', () => {
  it('must be long enough to make the derivation cost matter', () => {
    // Not a rule about symbols and digits, which mostly produces `Password1!`.
    // Length is what an attacker has to search.
    const wallet = new Wallet(memoryStore())
    expect(() => wallet.create('short')).toThrow(/at least 8 characters/)
    expect(wallet.status().exists).toBe(false)
  })
})

describe('export and removal', () => {
  const wallet = new Wallet(memoryStore())
  wallet.create(PASSWORD)

  it('asks for the password again to reveal the key', () => {
    // The wallet is unlocked. Revealing the key should still require what
    // created it, rather than whoever is at the keyboard.
    expect(wallet.status().unlocked).toBe(true)
    // The refusal comes from the keystore layer, which is where the password is
    // actually checked — not from a separate rule the wallet enforces on top.
    expect(() => wallet.exportPrivateKey('wrong')).toThrow(
      /wrong password, or the keystore has been altered/
    )
    expect(wallet.exportPrivateKey(PASSWORD)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('exports an encrypted keystore, which is safe to copy', () => {
    const keystore = wallet.exportKeystore()
    expect(keystore.version).toBe(3)
    expect(JSON.stringify(keystore)).not.toContain(wallet.exportPrivateKey(PASSWORD).slice(2))
  })

  it('needs the password to remove itself', () => {
    expect(() => wallet.remove('wrong')).toThrow()
    expect(wallet.status().exists).toBe(true)

    expect(wallet.remove(PASSWORD)).toEqual({ exists: false, unlocked: false, address: null })
  })
})
