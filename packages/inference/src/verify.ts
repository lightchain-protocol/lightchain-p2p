import { encodeParameters, hashDigestForSigning, keccak256, recoverAddress } from '@lcai-p2p/chain'

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
