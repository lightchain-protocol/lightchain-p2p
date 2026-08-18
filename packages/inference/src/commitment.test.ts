import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from '@lcai-p2p/chain'
import { checkCommitment } from './index.js'

/**
 * A signature says the worker produced these bytes. This asks whether they are
 * the bytes it told the registry it produced — the only discrepancy the chain
 * will actually punish, and the only one worth filing a dispute over.
 */

const ciphertext = new Uint8Array([1, 2, 3, 4, 5])
const recorded = toHex(keccak256(ciphertext))

describe('what the worker committed to', () => {
  it('matches when the recorded hash is the answer that arrived', () => {
    expect(checkCommitment(recorded, 'completed', ciphertext)).toEqual({ status: 'matches' })
  })

  it('reports grounds for a dispute when it recorded something else', () => {
    const elsewhere = toHex(keccak256(new Uint8Array([9, 9, 9])))
    expect(checkCommitment(elsewhere, 'completed', ciphertext)).toEqual({
      status: 'differs',
      recorded: elsewhere,
      received: recorded
    })
  })

  it('waits rather than judging a job that has not completed', () => {
    // Nothing is recorded until the worker finishes, so comparing against an
    // empty hash would report every answer as disputable for a few seconds.
    for (const state of ['submitted', 'acknowledged']) {
      expect(checkCommitment('0x' + '00'.repeat(32), state, ciphertext)).toEqual({
        status: 'pending',
        state
      })
    }
  })

  it('does not care about the case of the recorded hash', () => {
    expect(
      checkCommitment(recorded.toUpperCase().replace('0X', '0x'), 'completed', ciphertext)
    ).toEqual({ status: 'matches' })
  })
})
