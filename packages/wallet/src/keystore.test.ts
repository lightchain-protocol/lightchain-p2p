import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { KeystoreError, SCRYPT_N, addressOf, decrypt, encrypt } from './index.js'

/**
 * Foundry is the oracle.
 *
 * The whole argument for keystore V3 over something with nicer primitives is
 * that the key is never trapped here — so that claim is the thing worth
 * testing, and it can only be tested against a different implementation.
 * `cast` is installed on developer machines and skipped where it is not.
 *
 * These tests are slow by design. scrypt at N=262144 is half a second per
 * call, which is the cost that protects a stolen keystore.
 */

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const PASSWORD = 'correct horse battery staple'

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcai-keystore-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function cast(args: string[], input?: string): string | null {
  try {
    return execFileSync('cast', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

const haveCast = cast(['--version']) !== null

describe('round trip', () => {
  it('recovers exactly the key it was given', () => {
    const keystore = encrypt(KEY, PASSWORD)
    expect(decrypt(keystore, PASSWORD)).toBe(KEY)
  })

  it('records the right address without needing the password', () => {
    const keystore = encrypt(KEY, PASSWORD)
    expect(addressOf(keystore)?.toLowerCase()).toBe(privateKeyToAccount(KEY).address.toLowerCase())
  })

  it('produces a different file every time, from the same key and password', () => {
    // A fresh salt and IV per encryption. Identical output would mean one of
    // them is fixed, and a fixed salt makes a rainbow table possible.
    const a = encrypt(KEY, PASSWORD)
    const b = encrypt(KEY, PASSWORD)
    expect(a.crypto.ciphertext).not.toBe(b.crypto.ciphertext)
    expect(a.crypto.kdfparams.salt).not.toBe(b.crypto.kdfparams.salt)
    expect(a.crypto.cipherparams.iv).not.toBe(b.crypto.cipherparams.iv)
    expect(decrypt(b, PASSWORD)).toBe(KEY)
  })

  it('uses parameters that cost an attacker something', () => {
    const keystore = encrypt(KEY, PASSWORD)
    expect(keystore.crypto.kdfparams.n).toBe(SCRYPT_N)
    expect(keystore.crypto.kdf).toBe('scrypt')
    // geth's "light" preset is N=4096, sixty times cheaper to attack.
    expect(keystore.crypto.kdfparams.n).toBeGreaterThanOrEqual(262_144)
  })
})

describe('refusing', () => {
  it('rejects a wrong password without saying it was the password', () => {
    // Distinguishing "wrong password" from "tampered file" tells an attacker
    // which half they got right.
    const keystore = encrypt(KEY, PASSWORD)
    expect(() => decrypt(keystore, 'not the password')).toThrow(
      /wrong password, or the keystore has been altered/
    )
  })

  it('detects a tampered ciphertext', () => {
    const keystore = encrypt(KEY, PASSWORD)
    const tampered = {
      ...keystore,
      crypto: {
        ...keystore.crypto,
        ciphertext: keystore.crypto.ciphertext.replace(/^../, '00')
      }
    }
    expect(() => decrypt(tampered, PASSWORD)).toThrow(KeystoreError)
  })

  it('detects a swapped MAC', () => {
    const keystore = encrypt(KEY, PASSWORD)
    const other = encrypt(KEY, 'a different password entirely')
    expect(() =>
      decrypt({ ...keystore, crypto: { ...keystore.crypto, mac: other.crypto.mac } }, PASSWORD)
    ).toThrow(KeystoreError)
  })

  it('refuses an empty password rather than writing something that looks encrypted', () => {
    expect(() => encrypt(KEY, '')).toThrow(/password is required/)
  })

  it('refuses parameters that would make it fast or unopenable', () => {
    const keystore = encrypt(KEY, PASSWORD)

    // N=2 would decrypt instantly and offer nothing.
    const weak = {
      ...keystore,
      crypto: { ...keystore.crypto, kdfparams: { ...keystore.crypto.kdfparams, n: 2 } }
    }
    expect(() => decrypt(weak, PASSWORD)).toThrow(/out of range/)

    // And a hostile file claiming an enormous N would exhaust memory on open.
    const huge = {
      ...keystore,
      crypto: { ...keystore.crypto, kdfparams: { ...keystore.crypto.kdfparams, n: 2 ** 30 } }
    }
    expect(() => decrypt(huge, PASSWORD)).toThrow(/out of range/)
  })

  it('refuses formats it does not read', () => {
    const keystore = encrypt(KEY, PASSWORD)
    expect(() => decrypt({ ...keystore, version: 1 }, PASSWORD)).toThrow(/version/)
    expect(() =>
      decrypt({ ...keystore, crypto: { ...keystore.crypto, kdf: 'pbkdf2' } }, PASSWORD)
    ).toThrow(/kdf/)
    expect(() => decrypt(null, PASSWORD)).toThrow(KeystoreError)
  })

  it('catches a keystore whose stated address is not its key', () => {
    const keystore = encrypt(KEY, PASSWORD)
    const lying = { ...keystore, address: '0000000000000000000000000000000000000001' }
    expect(() => decrypt(lying, PASSWORD)).toThrow(/does not match/)
  })
})

describe.skipIf(!haveCast)('Foundry reads and writes the same files', () => {
  it('cast can decrypt what this wrote', () => {
    // The interoperability claim, tested rather than asserted. If this fails,
    // the key is trapped in this application.
    const dir = scratch()
    const keystore = encrypt(KEY, PASSWORD)
    writeFileSync(join(dir, 'wallet.json'), JSON.stringify(keystore))

    const recovered = cast([
      'wallet',
      'decrypt-keystore',
      '--keystore-dir',
      dir,
      '--unsafe-password',
      PASSWORD,
      'wallet.json'
    ])

    expect(recovered).not.toBeNull()
    expect(recovered?.toLowerCase()).toContain(KEY.slice(2))
  }, 60_000)

  it('this can decrypt what cast wrote', () => {
    const dir = scratch()
    const written = cast([
      'wallet',
      'import',
      'imported',
      '--keystore-dir',
      dir,
      '--private-key',
      KEY,
      '--unsafe-password',
      PASSWORD
    ])
    expect(written).not.toBeNull()

    const file = readdirSync(dir)[0] as string
    const keystore = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      crypto: { kdfparams: { n: number } }
    }

    expect(decrypt(keystore, PASSWORD)).toBe(KEY)

    // Foundry omits the address entirely, so the only way to learn it is to
    // decrypt. Reporting null is the honest answer; `0xundefined` was not.
    expect(addressOf(keystore)).toBeNull()

    // And it uses far weaker scrypt parameters than we write. Opening its
    // files anyway is right — refusing to read a valid keystore because
    // somebody else chose a low cost would strand the user's key.
    expect(keystore.crypto.kdfparams.n).toBeLessThan(SCRYPT_N)
  }, 60_000)
})
