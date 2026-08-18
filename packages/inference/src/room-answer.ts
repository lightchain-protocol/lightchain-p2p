import { toBytes } from '@lcai-p2p/chain'
import type { ModelAnswer } from '@lcai-p2p/protocol'
import { decrypt } from '@lcai-p2p/inference-crypto'
import { SignatureError, recoverFrameSigner } from './verify.js'

/**
 * Checking a model's answer that somebody else relayed into a room.
 *
 * When one person asks a model on behalf of a room, everyone else is reading a
 * quotation. Without this they would be trusting the person who pasted it — and
 * a chat where anyone can attribute arbitrary text to a model is worse than one
 * with no models in it, because the text arrives with the authority of having
 * been paid for.
 *
 * Two things are checked, and both matter:
 *
 * 1. The worker signed this ciphertext, for this job and session.
 * 2. The ciphertext decrypts, under the published key, to exactly the text on
 *    display.
 *
 * The first without the second proves only that a worker once said *something*.
 */

export interface AnswerChecks {
  readonly chainId: number
  readonly jobRegistry: string
}

export class AnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnswerError'
  }
}

export function verifyRoomAnswer(answer: ModelAnswer, text: string, chain: AnswerChecks): void {
  const ciphertext = new Uint8Array(Buffer.from(answer.ciphertext, 'base64'))

  let signer: string
  try {
    signer = recoverFrameSigner({
      chainId: chain.chainId,
      jobRegistry: chain.jobRegistry,
      jobId: BigInt(answer.jobId),
      sessionId: BigInt(answer.sessionId),
      ciphertext,
      signature: answer.signature
    })
  } catch (err) {
    throw new AnswerError(
      `the worker signature could not be read: ${(err as SignatureError).message}`
    )
  }

  if (signer.toLowerCase() !== answer.worker.toLowerCase()) {
    throw new AnswerError(
      `this answer claims to come from worker ${answer.worker} but was signed by ${signer}`
    )
  }

  let plaintext: string
  try {
    plaintext = new TextDecoder().decode(decrypt(toBytes(answer.sessionKey), ciphertext))
  } catch {
    throw new AnswerError('the published key does not open the ciphertext')
  }

  if (plaintext !== text) {
    // The signature held and the text was still changed: somebody kept a real
    // answer and put different words in front of it.
    throw new AnswerError('the text shown is not what the worker signed')
  }
}

/** True when the answer holds up. For rendering, where a reason is not wanted. */
export function isAnswerVerified(answer: ModelAnswer, text: string, chain: AnswerChecks): boolean {
  try {
    verifyRoomAnswer(answer, text, chain)
    return true
  } catch {
    return false
  }
}
