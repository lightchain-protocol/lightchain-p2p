import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { fromPrivateKey, hashDigestForSigning, toBytes, toHex } from '@lcai-p2p/chain'
import { SignatureError, recoverFrameSigner, responseDigest, verifyFrame } from './index.js'

/**
 * The important test here is the first one: a frame captured off the live
 * mainnet relay, checked against the worker the dispatcher actually assigned.
 *
 * A verifier can be self-consistently wrong — sign and check with the same
 * mistaken preimage and everything passes, then every real answer is rejected.
 * Only a vector produced by someone else's code rules that out.
 */

// Captured from wss://relay.mainnet.lightchain.ai, job 2699.
const REAL = {
  chainId: 9200,
  jobRegistry: '0xfb15f90298e4ccd7106e76ffb5e520315cc42b0b',
  jobId: 2699n,
  sessionId: 2360n,
  ciphertext: new Uint8Array(Buffer.from('XVANP0Gq2fVTE9ZVXd1Ukrwk7dt51zSguXIeiijm', 'base64')),
  signature:
    '0x870c9b5abd3106e74f387d62cbb066ab4b8499458f6758485b4b73e9440a3f3a4ff43c560918587068dadbf4eb7f2311e33936bf84ce2a48572a0979b0ccbe6400'
}

/** The worker the dispatcher assigned to session 2360. */
const WORKER = '0xdB258B4b8b69E417151A175C853B15A48a16E2Cf'

describe('a real frame from mainnet', () => {
  it('recovers the worker that was assigned to the session', () => {
    expect(recoverFrameSigner(REAL)).toBe(WORKER)
  })

  it('passes verification against that worker', () => {
    expect(() => verifyFrame(REAL, WORKER)).not.toThrow()
    // And case does not matter, because addresses arrive checksummed or not.
    expect(() => verifyFrame(REAL, WORKER.toLowerCase())).not.toThrow()
  })

  it('carries a recovery byte of 0, which Ethereum tooling writes as 27', () => {
    // The workers sign with raw secp256k1 recovery ids while contracts expect
    // the Ethereum convention. A verifier that accepts only one rejects the
    // network's own frames.
    expect(REAL.signature.slice(-2)).toBe('00')
  })
})

describe('what verification is for', () => {
  it('rejects a substituted answer', () => {
    // The attack this exists to stop: a relay replaces the ciphertext with its
    // own and forwards the worker's signature unchanged.
    const substituted = { ...REAL, ciphertext: new Uint8Array(REAL.ciphertext).fill(0x41) }
    expect(() => verifyFrame(substituted, WORKER)).toThrow(SignatureError)
    expect(() => verifyFrame(substituted, WORKER)).toThrow(/not by the worker assigned/)
  })

  it('rejects an answer signed by somebody else', () => {
    // Anvil's first key, standing in for a relay that signs its own inventions.
    const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const impostor = fromPrivateKey(KEY)
    const forged = {
      ...REAL,
      signature: toHex(signDigest(KEY, hashDigestForSigning(responseDigest(REAL))))
    }

    expect(() => verifyFrame(forged, WORKER)).toThrow(/not by the worker assigned/)
    // And it names who did sign, which is more use than "verification failed".
    try {
      verifyFrame(forged, WORKER)
    } catch (err) {
      expect((err as SignatureError).signer).toBe(impostor.address)
    }
  })

  it('rejects a frame that binds to a different job or session', () => {
    // The job and session are in the digest, so a valid answer replayed
    // against another job does not verify.
    expect(() => verifyFrame({ ...REAL, jobId: 2700n }, WORKER)).toThrow(SignatureError)
    expect(() => verifyFrame({ ...REAL, sessionId: 1n }, WORKER)).toThrow(SignatureError)
  })

  it('rejects a frame from another chain or another registry', () => {
    expect(() => verifyFrame({ ...REAL, chainId: 8200 }, WORKER)).toThrow(SignatureError)
    expect(() =>
      verifyFrame({ ...REAL, jobRegistry: '0x531b3a87c5d785441b9cf55b98169f20fd9056a7' }, WORKER)
    ).toThrow(SignatureError)
  })

  it('refuses a frame with no signature at all', () => {
    expect(() => verifyFrame({ ...REAL, signature: '' }, WORKER)).toThrow(/carried no signature/)
  })

  it('refuses a signature that is not one', () => {
    expect(() => verifyFrame({ ...REAL, signature: '0xdeadbeef' }, WORKER)).toThrow(
      /could not be read/
    )
  })
})

/**
 * Signs a prepared digest the way a worker does: raw recovery id, appended.
 *
 * Straight to the curve rather than through an `Account`, because signing
 * arbitrary bytes is exactly the primitive a wallet should not expose — and
 * here it is standing in for an attacker anyway.
 */
function signDigest(privateKey: string, digest: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(digest, toBytes(privateKey), {
    prehash: false,
    format: 'recovered'
  })
  // noble puts recovery first; the wire format puts it last.
  const out = new Uint8Array(65)
  out.set(recovered.slice(1), 0)
  out[64] = recovered[0] as number
  return out
}
