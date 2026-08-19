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

describe('an answer that arrived in pieces', () => {
  /**
   * A streamed answer, as the relay delivers one and a room would quote it.
   *
   * The worker signs each piece over its own ciphertext, so there is no single
   * artifact covering the whole reply — which is why these could not be quoted
   * into a room at all until the format carried a list.
   */
  function streamed(pieces: readonly string[], over: Partial<ModelAnswer> = {}): ModelAnswer {
    const sessionKey = generateSessionKey()

    const frames = pieces.map((piece) => {
      const ciphertext = encrypt(sessionKey, new TextEncoder().encode(piece))
      const digest = responseDigest({
        chainId: CHAIN.chainId,
        jobRegistry: CHAIN.jobRegistry,
        jobId: 7n,
        sessionId: 3n,
        ciphertext
      })
      return {
        ciphertext: Buffer.from(ciphertext).toString('base64'),
        signature: toHex(signDigest(WORKER_KEY, hashDigestForSigning(digest)))
      }
    })

    return {
      model: 'llama3-8b',
      jobId: '7',
      sessionId: '3',
      worker: worker.address,
      sessionKey: toHex(sessionKey),
      frames,
      ...over
    }
  }

  const PIECES = ['A Merkle tree ', 'summarises a dataset ', 'into one hash.']
  const WHOLE = PIECES.join('')

  it('verifies when every piece is signed and they join to what is shown', () => {
    expect(() => verifyRoomAnswer(streamed(PIECES), WHOLE, CHAIN)).not.toThrow()
    expect(isAnswerVerified(streamed(PIECES), WHOLE, CHAIN)).toBe(true)
  })

  it('catches a piece that was dropped', () => {
    // Silently the most useful edit available to a dishonest quoter: leave out
    // the sentence that qualifies the rest. Every remaining signature holds.
    const answer = streamed(PIECES)
    const short = { ...answer, frames: answer.frames!.slice(0, 2) }

    expect(() => verifyRoomAnswer(short, WHOLE, CHAIN)).toThrow(/not what the worker signed/)
  })

  it('catches pieces put back in the wrong order', () => {
    const answer = streamed(PIECES)
    const shuffled = {
      ...answer,
      frames: [answer.frames![1]!, answer.frames![0]!, answer.frames![2]!]
    }

    expect(() => verifyRoomAnswer(shuffled, WHOLE, CHAIN)).toThrow(/not what the worker signed/)
  })

  it('catches a piece repeated to say something twice', () => {
    const answer = streamed(PIECES)
    const doubled = { ...answer, frames: [...answer.frames!, answer.frames![2]!] }

    expect(() => verifyRoomAnswer(doubled, WHOLE, CHAIN)).toThrow(/not what the worker signed/)
  })

  it('catches one forged piece among genuine ones', () => {
    // The reason every frame is checked rather than the first: an answer whose
    // opening is real and whose middle was written by the person quoting it.
    const real = streamed(PIECES)
    const fake = streamed(['something else entirely'])
    const spliced = {
      ...real,
      frames: [real.frames![0]!, fake.frames![0]!, real.frames![2]!]
    }

    expect(() => verifyRoomAnswer(spliced, WHOLE, CHAIN)).toThrow(AnswerError)
  })

  it('says which piece failed, since one of forty is otherwise a needle', () => {
    const answer = streamed(PIECES)
    const broken = {
      ...answer,
      frames: [
        answer.frames![0]!,
        { ...answer.frames![1]!, signature: '0xbad' },
        answer.frames![2]!
      ]
    }

    expect(() => verifyRoomAnswer(broken, WHOLE, CHAIN)).toThrow(/piece 2 of 3/)
  })

  it('refuses an answer carrying no evidence at all', () => {
    const answer = streamed(PIECES)
    const empty = { ...answer, frames: undefined } as ModelAnswer

    expect(() => verifyRoomAnswer(empty, WHOLE, CHAIN)).toThrow(/no evidence/)
  })

  it('still reads a single-artifact answer, which is what every old one is', () => {
    // These are in logs already and cannot be rewritten.
    const text = 'written before streaming existed'
    expect(isAnswerVerified(answered(text), text, CHAIN)).toBe(true)
  })
})
