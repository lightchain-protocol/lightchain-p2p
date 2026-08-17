/**
 * Proves that Bare and Node produce and read the same bytes.
 *
 * The unit tests run under Node, where this module's WebCrypto counterpart is
 * available and `crypto` is Node's own. Neither is true in the worker, which is
 * where this code actually has to run: there, `crypto` is `bare-crypto` and
 * there is no WebCrypto to fall back on. A suite that only ever runs under Node
 * cannot tell you the thing you most need to know.
 *
 * One runtime emits keys and ciphertext; the other reads them and emits its
 * own. Run both directions:
 *
 *     pnpm check:bare
 *
 * Anything that disagrees fails loudly, and a passing run means a worker could
 * decrypt what this produced.
 */

import fs from 'fs'
import {
  decrypt,
  decryptSessionKey,
  derivePublicKey,
  deriveSharedSecret,
  encrypt,
  encryptSessionKey,
  generateKeyPair,
  generateSessionKey
} from '../dist/index.js'

const runtime = typeof Bare === 'undefined' ? 'node' : 'bare'
const argv = runtime === 'bare' ? Bare.argv.slice(2) : process.argv.slice(2)
const [mode, file] = argv

const readFile = (p) => fs.readFileSync(p, 'utf8')
const writeFile = (p, s) => {
  fs.mkdirSync('.tmp', { recursive: true })
  fs.writeFileSync(p, s)
}

const hex = (u8) => Buffer.from(u8).toString('hex')
const bytes = (s) => new Uint8Array(Buffer.from(s, 'hex'))
const text = (s) => new Uint8Array(Buffer.from(s, 'utf8'))

const PLAINTEXT = 'the quick brown fox jumps over the lazy dog'

function fail(what, expected, actual) {
  console.error(`\nFAIL (${runtime}): ${what}`)
  console.error(`  expected ${expected}`)
  console.error(`  actual   ${actual}`)
  if (runtime === 'bare') Bare.exit(1)
  else process.exit(1)
}

if (mode === '--emit') {
  const client = generateKeyPair()
  const worker = generateKeyPair()
  const sessionKey = generateSessionKey()

  writeFile(
    file,
    JSON.stringify(
      {
        emittedBy: runtime,
        clientSecretKey: hex(client.secretKey),
        clientPublicKey: hex(client.publicKey),
        workerSecretKey: hex(worker.secretKey),
        workerPublicKey: hex(worker.publicKey),
        sharedSecret: hex(deriveSharedSecret(client.secretKey, worker.publicKey)),
        sessionKey: hex(sessionKey),
        message: PLAINTEXT,
        ciphertext: hex(encrypt(sessionKey, text(PLAINTEXT))),
        wrappedSessionKey: hex(encryptSessionKey(sessionKey, worker.publicKey))
      },
      null,
      2
    )
  )
  console.log(`${runtime}: emitted ${file}`)
} else if (mode === '--verify') {
  const v = JSON.parse(readFile(file))
  console.log(`${runtime}: verifying vectors emitted by ${v.emittedBy}`)

  const clientSecretKey = bytes(v.clientSecretKey)
  const workerSecretKey = bytes(v.workerSecretKey)
  const workerPublicKey = bytes(v.workerPublicKey)

  const pub = hex(derivePublicKey(clientSecretKey))
  if (pub !== v.clientPublicKey) fail('public key from scalar', v.clientPublicKey, pub)

  const shared = hex(deriveSharedSecret(clientSecretKey, workerPublicKey))
  if (shared !== v.sharedSecret) fail('ECDH shared secret', v.sharedSecret, shared)

  // The other side of the exchange must reach the same secret.
  const reverse = hex(deriveSharedSecret(workerSecretKey, bytes(v.clientPublicKey)))
  if (reverse !== v.sharedSecret) fail('reverse ECDH shared secret', v.sharedSecret, reverse)

  const plaintext = Buffer.from(decrypt(bytes(v.sessionKey), bytes(v.ciphertext))).toString()
  if (plaintext !== v.message) fail('decrypted message', v.message, plaintext)

  const unwrapped = hex(decryptSessionKey(bytes(v.wrappedSessionKey), workerSecretKey))
  if (unwrapped !== v.sessionKey) fail('unwrapped session key', v.sessionKey, unwrapped)

  console.log(`${runtime}: public key, ECDH both ways, AES-GCM and session key wrap all agree`)
} else {
  console.error('usage: cross-runtime.mjs --emit <file> | --verify <file>')
  if (runtime === 'bare') Bare.exit(1)
  else process.exit(1)
}
