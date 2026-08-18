import {
  encodeParameters,
  hashDigestForSigning,
  keccak256,
  recoverAddress,
  toHex
} from '@lcai-p2p/chain'

/**
 * Checking that the worker really said this.
 *
 * Every relay frame carries a signature and, in this stack as it stands,
 * **nothing verifies it** — not the relay, which forwards it unchanged, and not
 * the web client, which types the field and never reads it. So a relay that
 * wanted to could substitute an answer. It could not read the prompt or forge
 * the payment, but it could lie about the reply, which for something people
 * will act on is the part that matters.
 *
 * The preimage is not ours to choose. It is what `JobRegistry`'s
 * `disputeResponseMismatch` checks on chain:
 *
 * ```solidity
 * keccak256(abi.encode(block.chainid, address(this), jobId, sessionId, ciphertext))
 * ```
 *
 * then EIP-191 over that digest. Verifying the same thing the contract does
 * means a frame that fails here is a frame we hold the evidence to dispute.
 */

export class SignatureError extends Error {
  /** Who actually signed, when anybody did. */
  readonly signer: string | null

  constructor(message: string, signer: string | null = null) {
    super(message)
    this.name = 'SignatureError'
    this.signer = signer
  }
}

export interface FrameToVerify {
  readonly chainId: number
  readonly jobRegistry: string
  readonly jobId: bigint
  readonly sessionId: bigint
  /** The decoded ciphertext, not the base64 it arrived as. */
  readonly ciphertext: Uint8Array
  readonly signature: string
}

/** The digest the worker signed, and the contract would recompute. */
export function responseDigest(frame: Omit<FrameToVerify, 'signature'>): Uint8Array {
  return keccak256(
    encodeParameters(
      ['uint256', 'address', 'uint256', 'uint256', 'bytes'],
      [BigInt(frame.chainId), frame.jobRegistry, frame.jobId, frame.sessionId, frame.ciphertext]
    )
  )
}

/**
 * Who signed a frame.
 *
 * Returns the address rather than a boolean so a mismatch can name the
 * impostor, which is the difference between "verification failed" and
 * something a person can act on.
 */
export function recoverFrameSigner(frame: FrameToVerify): string {
  return recoverAddress(hashDigestForSigning(responseDigest(frame)), frame.signature)
}

/**
 * Whether the worker committed on chain to the answer it sent.
 *
 * A separate question from whether it signed, and the more interesting one. A
 * signature only proves the worker produced these bytes; this asks whether
 * those are the bytes it *told the registry* it produced. A worker that hands
 * one ciphertext to a consumer and records the hash of another has equivocated,
 * and that is the one thing `disputeResponseMismatch` will slash it for.
 *
 * A job that has not reached `completed` has nothing recorded yet, so this says
 * `pending` rather than pretending to an answer.
 */
export type Commitment =
  | { readonly status: 'matches' }
  | { readonly status: 'pending'; readonly state: string }
  /** Grounds for a dispute: the worker signed this and recorded something else. */
  | { readonly status: 'differs'; readonly recorded: string; readonly received: string }

export function checkCommitment(
  recordedHash: string,
  state: string,
  ciphertext: Uint8Array
): Commitment {
  if (state !== 'completed') return { status: 'pending', state }

  const received = toHex(keccak256(ciphertext))
  return received.toLowerCase() === recordedHash.toLowerCase()
    ? { status: 'matches' }
    : { status: 'differs', recorded: recordedHash, received }
}

/** Throws unless `expected` signed the frame. */
export function verifyFrame(frame: FrameToVerify, expected: string): void {
  if (!frame.signature) {
    throw new SignatureError('the frame carried no signature')
  }

  let signer: string
  try {
    signer = recoverFrameSigner(frame)
  } catch (err) {
    throw new SignatureError(`the signature could not be read: ${(err as Error).message}`)
  }

  if (signer.toLowerCase() !== expected.toLowerCase()) {
    throw new SignatureError(
      `this answer was signed by ${signer}, not by the worker assigned to the session (${expected}). Discarding it.`,
      signer
    )
  }
}
