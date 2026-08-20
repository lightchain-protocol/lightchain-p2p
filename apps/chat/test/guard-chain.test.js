import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIRM_ABOVE, LIGHTCHAIN_CHAIN_ID, createGuard } from '../workers/guard.mjs'

/**
 * The threshold's chain awareness — the regression for a fifty-ether send that
 * the guard once waved through.
 *
 * The amount is always in the spent chain's native wei, and wei are not a
 * currency: a hundred LCAI and a hundred ether are the same figure with three
 * orders of magnitude between their worth. So the hundred-token courtesy is
 * Lightchain's alone, and every native move anywhere else is worth an
 * interruption. These tests pin that, because the failure it prevents is
 * silent — nothing throws when a threshold is too low, the money just leaves.
 */

const ONE = 10n ** 18n

/** What a token send looks like to the guard: a value no threshold survives. */
const CONFIRM_ALWAYS = 2n ** 255n

const ETHEREUM_CHAIN_ID = 1

function guardWith() {
  const pushed = []
  const guard = createGuard({
    wallet: { verifyPassword: vi.fn(), lockIfIdle: vi.fn(() => false), touch: vi.fn() },
    send: (msg) => pushed.push(msg),
    settings: () => ({}),
    onAutoLock: vi.fn()
  })

  /** Answers the dialog the way a person would, once one has been pushed. */
  const answer = async (approved) => {
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    const { id } = pushed.findLast((msg) => msg.t === 'wallet.confirm')
    guard.settle(id, approved)
  }

  return { guard, pushed, answer }
}

const details = { amount: '50 LCAI', to: '0xabc', from: '0xdef', network: 'Lightchain (chain 9200)' }

describe('a threshold that knows which chain it is on', () => {
  it('lets a modest Lightchain send go without asking', async () => {
    // Fifty LCAI is under the hundred-token courtesy and stays an interruption
    // nobody needed.
    const { guard, pushed } = guardWith()
    await expect(
      guard.allow({ value: 50n * ONE, chainId: LIGHTCHAIN_CHAIN_ID, details })
    ).resolves.toBeUndefined()
    expect(pushed).toHaveLength(0)
  })

  it('asks about a Lightchain send past the threshold', async () => {
    const { guard, pushed, answer } = guardWith()
    const allowed = guard.allow({ value: 150n * ONE, chainId: LIGHTCHAIN_CHAIN_ID, details })

    await answer(true)
    await expect(allowed).resolves.toBeUndefined()
    expect(pushed[0].t).toBe('wallet.confirm')
  })

  it('asks about any native value on another chain, down to a single wei', async () => {
    // The hundred-token figure read in ether is not a courtesy, it is a hole:
    // this is the fifty-ether send that used to go without a word. The strict
    // reading has no floor — a dust send on Ethereum costs real money too.
    const { guard, pushed, answer } = guardWith()
    const allowed = guard.allow({ value: 1n, chainId: ETHEREUM_CHAIN_ID, details })

    await answer(true)
    await expect(allowed).resolves.toBeUndefined()
    expect(pushed[0].t).toBe('wallet.confirm')
  })

  it('still always asks about a token send, whatever the chain', async () => {
    // Tokens arrive as the sentinel rather than an amount, because their worth
    // is not known here. That contract is unchanged, on Lightchain and off it.
    for (const chainId of [LIGHTCHAIN_CHAIN_ID, ETHEREUM_CHAIN_ID, undefined]) {
      const { guard, pushed, answer } = guardWith()
      const allowed = guard.allow({ value: CONFIRM_ALWAYS, chainId, details })

      await answer(true)
      await expect(allowed).resolves.toBeUndefined()
      expect(pushed[0].t).toBe('wallet.confirm')
    }
  })

  it('keeps the old line for a call that names no chain', async () => {
    // The chain argument is an extension, not a new requirement: callers that
    // predate it — and the swap handler, edited elsewhere — must keep behaving
    // exactly as they did, threshold and all.
    const { guard, pushed } = guardWith()
    await expect(guard.allow({ value: 50n * ONE, details })).resolves.toBeUndefined()
    expect(pushed).toHaveLength(0)
  })

  it('keeps the Lightchain threshold exactly where it was', () => {
    // A chain-aware policy that quietly moved the existing line would be its
    // own kind of bug.
    expect(DEFAULT_CONFIRM_ABOVE).toBe(100n * ONE)
  })
})
