import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { fromPrivateKey, hashDigestForSigning, toBytes, toHex } from '@lcai-p2p/chain'
import type { ModelAnswer } from '@lcai-p2p/protocol'
import { encrypt, generateSessionKey } from '@lcai-p2p/inference-crypto'
import { AnswerError, isAnswerVerified, responseDigest, verifyRoomAnswer } from './index.js'

/**
 * The threat these tests describe is specific: one person asks a model for a
 * room, and everyone else reads a quotation. A chat where anyone can attribute
 * arbitrary text to a model is worse than one with no models in it, because
 * the text arrives with the authority of having been paid for.
 */

const CHAIN = { chainId: 9200, jobRegistry: '0xfb15f90298e4ccd7106e76ffb5e520315cc42b0b' }
const WORKER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const worker = fromPrivateKey(WORKER_KEY)

function signDigest(privateKey: string, digest: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(digest, toBytes(privateKey), {
    prehash: false,
    format: 'recovered'
  })
  const out = new Uint8Array(65)
  out.set(recovered.slice(1), 0)
  out[64] = recovered[0] as number
  return out
}

/** An answer as an honest relayer would post it. */
function answered(text: string, over: Partial<ModelAnswer> = {}): ModelAnswer {
  const sessionKey = generateSessionKey()
  const ciphertext = encrypt(sessionKey, new TextEncoder().encode(text))
  const digest = responseDigest({
    chainId: CHAIN.chainId,
    jobRegistry: CHAIN.jobRegistry,
    jobId: 7n,
    sessionId: 3n,
    ciphertext
  })

  return {
    model: 'llama3-8b',
    jobId: '7',
    sessionId: '3',
    worker: worker.address,
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    sessionKey: toHex(sessionKey),
    signature: toHex(signDigest(WORKER_KEY, hashDigestForSigning(digest))),
    ...over
  }
}

describe('an answer relayed into a room', () => {
  it('verifies when the worker signed exactly what is shown', () => {
    const text = 'A Merkle tree summarises a dataset into one hash.'
    expect(() => verifyRoomAnswer(answered(text), text, CHAIN)).not.toThrow()
    expect(isAnswerVerified(answered(text), text, CHAIN)).toBe(true)
  })

  it('catches text that was changed after the fact', () => {
    // The attack that matters: keep a real signed answer and put different
    // words in front of it. The signature still holds; the plaintext does not.
    const answer = answered('the model said this')
    expect(() => verifyRoomAnswer(answer, 'the model said something else', CHAIN)).toThrow(
      /not what the worker signed/
    )
  })

  it('catches an answer attributed to a worker that did not sign it', () => {
    const answer = answered('hello', { worker: '0x' + '22'.repeat(20) })
    expect(() => verifyRoomAnswer(answer, 'hello', CHAIN)).toThrow(/but was signed by/)
  })

  it('catches a key that does not open the ciphertext', () => {
    const answer = answered('hello', { sessionKey: toHex(generateSessionKey()) })
    expect(() => verifyRoomAnswer(answer, 'hello', CHAIN)).toThrow(/does not open the ciphertext/)
  })

  it('catches an answer lifted from another job or session', () => {
    // The job and session are inside the signed digest, so a real answer
    // cannot be re-presented as the reply to a different question.
    expect(() => verifyRoomAnswer(answered('hello', { jobId: '8' }), 'hello', CHAIN)).toThrow(
      AnswerError
    )
    expect(() => verifyRoomAnswer(answered('hello', { sessionId: '9' }), 'hello', CHAIN)).toThrow(
      AnswerError
    )
  })

  it('catches an answer from another chain', () => {
    const answer = answered('hello')
    expect(() => verifyRoomAnswer(answer, 'hello', { ...CHAIN, chainId: 8200 })).toThrow(
      AnswerError
    )
  })

  it('refuses a signature that is not one', () => {
    expect(() =>
      verifyRoomAnswer(answered('hello', { signature: '0xbad' }), 'hello', CHAIN)
    ).toThrow(/could not be read/)
  })

  it('checks the signature and the plaintext, not one or the other', () => {
    // A signature alone proves a worker once said something; a decryption alone
    // proves whoever posted it knows a key. Only together do they say that this
    // worker said this.
    const real = answered('genuine')
    const forged = answered('forged')

    const spliced: ModelAnswer = { ...real, ciphertext: forged.ciphertext }
    expect(() => verifyRoomAnswer(spliced, 'forged', CHAIN)).toThrow(/but was signed by|could not/)
  })
})
