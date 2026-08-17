import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CryptoError,
  PUBLIC_KEY_BYTES,
  SESSION_KEY_BYTES,
  decrypt,
  decryptSessionKey,
  derivePublicKey,
  deriveSharedSecret,
  encrypt,
  encryptSessionKey,
  generateKeyPair,
  generateSessionKey
} from './index.js'

/**
 * The other implementation.
 *
 * These helpers are a transcription of `lcai-chat-v2/lib/protocol/crypto.ts`,
 * the browser client that talks to the live workers, onto Node's WebCrypto.
 * That makes every test below a comparison between two independent stacks —
 * noble and `bare-crypto`/OpenSSL against OpenSSL's WebCrypto — rather than a
 * round trip through the code being tested, which would pass just as happily
 * if the format were wrong in both directions.
 *
 * The Go workers are the actual authority
 * (`lightchain-shared-pkg/crypto/{aes,ecdh,session_key}.go`). No Go toolchain
 * is available here, so this checks against the browser client that Go file
 * declares itself wire-compatible with, using the byte layouts read from both.
 */

const subtle = webcrypto.subtle
const hex = (u8: Uint8Array) => Buffer.from(u8).toString('hex')
const b64u = (u8: Uint8Array) => Buffer.from(u8).toString('base64url')
const text = new TextEncoder()

/**
 * A copy in a plain ArrayBuffer.
 *
 * WebCrypto's `BufferSource` excludes views backed by a `SharedArrayBuffer`,
 * and a `Uint8Array` is not statically known not to be. Copying satisfies that
 * and costs nothing at these sizes.
 */
const buf = (u8: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(u8.byteLength)
  new Uint8Array(out).set(u8)
  return out
}

/** Flips a bit, written out because indexed reads are `number | undefined` here. */
const flip = (u8: Uint8Array, index: number): Uint8Array => {
  const copy = Uint8Array.from(u8)
  copy[index] = (copy[index] ?? 0) ^ 0x01
  return copy
}

async function importPrivate(secretKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(secretKey),
      x: b64u(publicKey.subarray(1, 33)),
      y: b64u(publicKey.subarray(33, 65)),
      ext: true
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )
}

async function importPublic(publicKey: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', buf(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

async function refDeriveSharedSecret(priv: CryptoKey, pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256))
}

async function refEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const aes = await subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt'])
  const nonce = webcrypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aes, buf(plaintext))
  )
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce, 0)
  out.set(sealed, nonce.length)
  return out
}

async function refDecrypt(key: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const aes = await subtle.importKey('raw', buf(key), 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: buf(payload.subarray(0, 12)) },
      aes,
      buf(payload.subarray(12))
    )
  )
}

describe('agreeing with the browser client', () => {
  it('derives the same public key from the same scalar', async () => {
    const pair = generateKeyPair()
    const priv = await importPrivate(pair.secretKey, pair.publicKey)
    const exported = new Uint8Array(await subtle.exportKey('raw', await webcryptoPublic(priv)))

    expect(pair.publicKey).toHaveLength(PUBLIC_KEY_BYTES)
    expect(pair.publicKey[0]).toBe(0x04)
    expect(hex(exported)).toBe(hex(pair.publicKey))
  })

  it('derives the same shared secret', async () => {
    const alice = generateKeyPair()
    const bob = generateKeyPair()

    const ours = deriveSharedSecret(alice.secretKey, bob.publicKey)
    const theirs = await refDeriveSharedSecret(
      await importPrivate(alice.secretKey, alice.publicKey),
      await importPublic(bob.publicKey)
    )

    expect(hex(ours)).toBe(hex(theirs))
    // Both parties reach the same secret, which is the point of the exchange.
    expect(hex(deriveSharedSecret(bob.secretKey, alice.publicKey))).toBe(hex(ours))
  })

  it('produces ciphertext the browser client can read', async () => {
    const key = generateSessionKey()
    const message = text.encode('what is the capital of France?')

    const sealed = encrypt(key, message)
    expect(Buffer.from(await refDecrypt(key, sealed)).toString()).toBe(
      'what is the capital of France?'
    )
  })

  it('reads ciphertext the browser client produced', async () => {
    const key = generateSessionKey()
    const sealed = await refEncrypt(key, text.encode('Paris'))

    expect(Buffer.from(decrypt(key, sealed)).toString()).toBe('Paris')
  })

  it('wraps a session key the worker side can unwrap', async () => {
    // The direction that matters in production: a client wraps a session key
    // for a worker, and the worker unwraps it with its registered key.
    const worker = generateKeyPair()
    const sessionKey = generateSessionKey()

    const wrapped = encryptSessionKey(sessionKey, worker.publicKey)
    expect(wrapped).toHaveLength(PUBLIC_KEY_BYTES + 12 + SESSION_KEY_BYTES + 16)

    const ephemeralPublicKey = wrapped.subarray(0, PUBLIC_KEY_BYTES)
    const shared = await refDeriveSharedSecret(
      await importPrivate(worker.secretKey, worker.publicKey),
      await importPublic(ephemeralPublicKey)
    )
    const unwrapped = await refDecrypt(shared, wrapped.subarray(PUBLIC_KEY_BYTES))

    expect(hex(unwrapped)).toBe(hex(sessionKey))
  })

  it('unwraps a session key the browser client wrapped', async () => {
    const us = generateKeyPair()
    const sessionKey = generateSessionKey()

    const ephemeral = generateKeyPair()
    const shared = await refDeriveSharedSecret(
      await importPrivate(ephemeral.secretKey, ephemeral.publicKey),
      await importPublic(us.publicKey)
    )
    const sealed = await refEncrypt(shared, sessionKey)

    const wrapped = new Uint8Array(PUBLIC_KEY_BYTES + sealed.length)
    wrapped.set(ephemeral.publicKey, 0)
    wrapped.set(sealed, PUBLIC_KEY_BYTES)

    expect(hex(decryptSessionKey(wrapped, us.secretKey))).toBe(hex(sessionKey))
  })
})

describe('the format itself', () => {
  it('lays bytes out the way the Go worker expects', () => {
    const key = generateSessionKey()
    const sealed = encrypt(key, text.encode('abc'))

    // nonce(12) || ciphertext || tag(16), with GCM adding no length of its own.
    expect(sealed).toHaveLength(12 + 3 + 16)
  })

  it('uses a fresh nonce every time', () => {
    const key = generateSessionKey()
    const message = text.encode('the same message twice')

    const a = encrypt(key, message)
    const b = encrypt(key, message)

    // Reusing a nonce under one key is catastrophic for GCM: it leaks the
    // authentication subkey and lets an attacker forge.
    expect(hex(a.subarray(0, 12))).not.toBe(hex(b.subarray(0, 12)))
    expect(hex(a)).not.toBe(hex(b))
  })

  it('uses a fresh ephemeral key for every wrap', () => {
    const worker = generateKeyPair()
    const sessionKey = generateSessionKey()

    const first = encryptSessionKey(sessionKey, worker.publicKey)
    const second = encryptSessionKey(sessionKey, worker.publicKey)

    expect(hex(first.subarray(0, PUBLIC_KEY_BYTES))).not.toBe(
      hex(second.subarray(0, PUBLIC_KEY_BYTES))
    )
  })
})

describe('refusing bad input', () => {
  it('rejects a tampered ciphertext rather than returning wrong plaintext', () => {
    const key = generateSessionKey()
    const sealed = encrypt(key, text.encode('transfer 10 LCAI'))

    expect(() => decrypt(key, flip(sealed, 20))).toThrow(CryptoError)
  })

  it('rejects the wrong key', () => {
    const sealed = encrypt(generateSessionKey(), text.encode('secret'))
    expect(() => decrypt(generateSessionKey(), sealed)).toThrow(/wrong key or tampered/)
  })

  it('says nothing about which part of decryption failed', () => {
    const key = generateSessionKey()
    const sealed = encrypt(key, text.encode('secret'))

    // A message distinguishing a bad tag from bad padding is how padding
    // oracles start. Both failures read identically.
    expect(() => decrypt(key, flip(sealed, sealed.length - 1))).toThrow(/wrong key or tampered/)
    expect(() => decrypt(generateSessionKey(), sealed)).toThrow(/wrong key or tampered/)
  })

  it('rejects keys and payloads of the wrong size', () => {
    expect(() => encrypt(new Uint8Array(16), new Uint8Array(1))).toThrow(/must be 32 bytes/)
    expect(() => decrypt(generateSessionKey(), new Uint8Array(4))).toThrow(/too short/)
    expect(() => deriveSharedSecret(new Uint8Array(31), new Uint8Array(65))).toThrow(
      /secret key must be 32/
    )
    expect(() => deriveSharedSecret(new Uint8Array(32), new Uint8Array(33))).toThrow(
      /public key must be 65/
    )
    expect(() => decryptSessionKey(new Uint8Array(10), new Uint8Array(32))).toThrow(/too short/)
    expect(() => encryptSessionKey(new Uint8Array(31), generateKeyPair().publicKey)).toThrow(
      /session key must be 32/
    )
  })

  it('rejects a public key that is not on the curve', () => {
    const notOnCurve = new Uint8Array(PUBLIC_KEY_BYTES)
    notOnCurve[0] = 0x04
    notOnCurve.fill(0x11, 1)

    expect(() => deriveSharedSecret(generateKeyPair().secretKey, notOnCurve)).toThrow(CryptoError)
  })

  it('derives a public key only from a valid scalar', () => {
    const pair = generateKeyPair()
    expect(hex(derivePublicKey(pair.secretKey))).toBe(hex(pair.publicKey))
    expect(() => derivePublicKey(new Uint8Array(31))).toThrow(/must be 32 bytes/)
  })
})

/** WebCrypto has no direct private-to-public conversion, so go via JWK. */
async function webcryptoPublic(priv: CryptoKey): Promise<CryptoKey> {
  const jwk = await subtle.exportKey('jwk', priv)
  delete jwk.d
  jwk.key_ops = []
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}
