import { toBytes } from '@lcai-p2p/chain'
import { answerFrames, type ModelAnswer } from '@lcai-p2p/protocol'
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
  const frames = answerFrames(answer)
  if (frames.length === 0) {
    throw new AnswerError('this answer carries no evidence at all')
  }

  const key = toBytes(answer.sessionKey)
  let assembled = ''

  // Every frame, in order, and all of them. A streamed answer is signed a piece
  // at a time, so checking one piece and taking the rest on trust would leave
  // whoever quoted it free to write the rest — which is the whole thing this
  // exists to stop. The pieces are then joined and compared to what is on
  // screen, because signatures over five ciphertexts prove nothing about a
  // sentence somebody typed underneath them.
  for (const [index, frame] of frames.entries()) {
    const where = frames.length === 1 ? '' : ` (piece ${index + 1} of ${frames.length})`
    const ciphertext = new Uint8Array(Buffer.from(frame.ciphertext, 'base64'))

    let signer: string
    try {
      signer = recoverFrameSigner({
        chainId: chain.chainId,
        jobRegistry: chain.jobRegistry,
        jobId: BigInt(answer.jobId),
        sessionId: BigInt(answer.sessionId),
        ciphertext,
        signature: frame.signature
      })
    } catch (err) {
      throw new AnswerError(
        `the worker signature could not be read${where}: ${(err as SignatureError).message}`
      )
    }

    if (signer.toLowerCase() !== answer.worker.toLowerCase()) {
      throw new AnswerError(
        `this answer claims to come from worker ${answer.worker} but was signed by ${signer}${where}`
      )
    }

    try {
      assembled += new TextDecoder().decode(decrypt(key, ciphertext))
    } catch {
      throw new AnswerError(`the published key does not open the ciphertext${where}`)
    }
  }

  if (assembled !== text) {
    // The signatures held and the text was still changed: somebody kept a real
    // answer and put different words in front of it. With several pieces this
    // also catches one being dropped, duplicated or reordered, since none of
    // those reassemble into what was shown.
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
