import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIRM_ABOVE, createGuard, readableAmount } from '../workers/guard.mjs'

/**
 * The checks between a compromised window and somebody's money.
 *
 * Worth testing here rather than only through the interface, because every
 * failure mode has to fail closed and most of them are unreachable from a
 * harness: a dialog nobody answers, a window that never replies, an answer
 * quoting an id nobody asked about. Each of those must refuse or be ignored,
 * and none of them can be produced by clicking.
 */

const ONE = 10n ** 18n

function guardWith({ values = {} } = {}) {
  const pushed = []
  const wallet = {
    verifyPassword: vi.fn((given) => given === 'right'),
    lockIfIdle: vi.fn(() => false),
    touch: vi.fn()
  }

  const guard = createGuard({
    wallet,
    send: (msg) => pushed.push(msg),
    settings: () => values,
    onAutoLock: vi.fn()
  })

  /** Answers the most recent dialog the way a person would. */
  const answer = (approved) => {
    const { id } = pushed.findLast((msg) => msg.t === 'wallet.confirm')
    return guard.settle(id, approved)
  }

  return { guard, wallet, pushed, answer }
}

const details = { amount: '1 LCAI', to: '0xabc', from: '0xdef', network: 'mainnet' }

describe('showing an amount to a person', () => {
  it('writes whole tokens without a decimal point', () => {
    expect(readableAmount(ONE, 'LCAI')).toBe('1 LCAI')
    expect(readableAmount(1234n * ONE, 'LCAI')).toBe('1234 LCAI')
  })

  it('keeps the fraction without trailing zeros', () => {
    expect(readableAmount(ONE + ONE / 2n, 'LCAI')).toBe('1.5 LCAI')
    expect(readableAmount(ONE / 4n, 'ETH')).toBe('0.25 ETH')
  })

  it('never rounds a small amount away to nothing', () => {
    // One wei displayed as "0" in a confirmation would be the wrong direction
    // to be wrong in, even though nobody is defrauded by it.
    expect(readableAmount(1n, 'LCAI')).toBe('0.000000000000000001 LCAI')
  })

  it('says zero plainly', () => {
    expect(readableAmount(0n, 'LCAI')).toBe('0 LCAI')
  })

  it('handles a token that is not eighteen decimals', () => {
    expect(readableAmount(1_500_000n, 'USDC', 6)).toBe('1.5 USDC')
  })
})

describe('small amounts', () => {
  it('go through without asking anything', async () => {
    const { guard, wallet, pushed } = guardWith()
    await expect(guard.allow({ value: 1n, details })).resolves.toBeUndefined()

    expect(wallet.verifyPassword).not.toHaveBeenCalled()
    expect(pushed).toHaveLength(0)
  })
})

describe('mid-size amounts', () => {
  it('go through without asking anything - the password tier was removed', async () => {
    // There is no dialog that could collect a password, so demanding one was
    // a refusal wearing a prompt's clothes. What remains proportionate is the
    // confirmation dialog, and only for the largest moves.
    const { guard, wallet, pushed } = guardWith()
    await expect(guard.allow({ value: 10n ** 18n, details })).resolves.toBeUndefined()

    expect(wallet.verifyPassword).not.toHaveBeenCalled()
    expect(pushed).toHaveLength(0)
  })

  it('ignore a password that is offered anyway', async () => {
    const { guard, wallet } = guardWith()
    await expect(
      guard.allow({ value: 10n ** 18n, password: 'wrong', details })
    ).resolves.toBeUndefined()
    expect(wallet.verifyPassword).not.toHaveBeenCalled()
  })

  it('ignore a reauth threshold left in an old settings file', async () => {
    // The key was never window-writable; now it is not read either. Only
    // `confirmAboveWei` still tunes what the guard asks.
    const { guard, pushed } = guardWith({ values: { reauthAboveWei: '1' } })
    await expect(guard.allow({ value: 10n ** 18n, details })).resolves.toBeUndefined()
    expect(pushed).toHaveLength(0)
  })
})

describe('amounts past the dialog threshold', () => {
  const big = DEFAULT_CONFIRM_ABOVE

  it('ask the window, describing the transfer', async () => {
    const { guard, pushed, answer } = guardWith()
    const allowed = guard.allow({ value: big, details })

    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    const asked = pushed[0]
    expect(asked.t).toBe('wallet.confirm')
    expect(asked).toMatchObject(details)
    expect(asked.id).toBeTruthy()

    answer(true)
    await expect(allowed).resolves.toBeUndefined()
  })

  it('refuse when the answer is no', async () => {
    const { guard, pushed, answer } = guardWith()
    const allowed = guard.allow({ value: big, details })

    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    answer(false)
    await expect(allowed).rejects.toThrow(/not confirmed/)
  })

  it('take the threshold from settings when one is set', async () => {
    const { guard, pushed } = guardWith({ values: { confirmAboveWei: '5' } })
    await expect(guard.allow({ value: 4n, details })).resolves.toBeUndefined()
    expect(pushed).toHaveLength(0)

    const allowed = guard.allow({ value: 5n, details })
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    guard.stop()
    await expect(allowed).rejects.toThrow(/not confirmed/)
  })

  it('ignore a threshold that is not a number, rather than trusting it', async () => {
    // A settings file that has been edited into nonsense must make the check
    // stricter, never weaker. Falling back to the default does that.
    for (const bad of ['', 'lots', '-1', '1.5', null, {}]) {
      const { guard, pushed } = guardWith({ values: { confirmAboveWei: bad } })
      const allowed = guard.allow({ value: DEFAULT_CONFIRM_ABOVE, details })
      await vi.waitFor(() => expect(pushed).toHaveLength(1))
      guard.stop()
      await expect(allowed).rejects.toThrow(/not confirmed/)
    }
  })

  it('refuse when nobody ever answers', async () => {
    vi.useFakeTimers()
    try {
      const { guard } = guardWith()
      const allowed = guard.allow({ value: big, details })
      const settled = expect(allowed).rejects.toThrow(/not confirmed/)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignore an answer to a question nobody asked', () => {
    const { guard } = guardWith()
    // Nothing is waiting, so nothing can be settled — whether the id is
    // invented, stale, or simply late.
    expect(guard.settle('999', true)).toBe(false)
  })

  it('keep waiting when an answer names somebody else', async () => {
    vi.useFakeTimers()
    try {
      const { guard, pushed } = guardWith()
      const allowed = guard.allow({ value: big, details })
      const settled = expect(allowed).rejects.toThrow(/not confirmed/)

      await vi.waitFor(() => expect(pushed).toHaveLength(1))
      // A wrong id is a no-op, not a refusal and not an approval: the real
      // dialog is still open and the request still has its full five minutes.
      expect(guard.settle('not-the-id-that-was-sent', true)).toBe(false)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuse everything outstanding when the worker shuts down', async () => {
    const { guard, pushed } = guardWith()
    const allowed = guard.allow({ value: big, details })

    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    guard.stop()
    await expect(allowed).rejects.toThrow(/not confirmed/)
  })
})

describe('closing a dialog the guard no longer waits on', () => {
  // A dialog left up after the guard gave up on it is a Confirm that settles
  // nothing, with the next real question queued out of sight behind it.
  const big = DEFAULT_CONFIRM_ABOVE
  const retracted = (pushed, id) =>
    pushed.some((msg) => msg.t === 'wallet.confirm.retract' && msg.id === id)

  it('retracts the question once it is answered', async () => {
    const { guard, pushed, answer } = guardWith()
    const allowed = guard.allow({ value: big, details })
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    const { id } = pushed[0]

    answer(false)
    await expect(allowed).rejects.toThrow(/not confirmed/)
    expect(retracted(pushed, id)).toBe(true)
  })

  it('retracts the question when it times out', async () => {
    vi.useFakeTimers()
    try {
      const { guard, pushed } = guardWith()
      const allowed = guard.allow({ value: big, details })
      const settled = expect(allowed).rejects.toThrow(/not confirmed/)
      await vi.waitFor(() => expect(pushed).toHaveLength(1))
      const { id } = pushed[0]

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      await settled
      expect(retracted(pushed, id)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retracts every question outstanding when the worker shuts down', async () => {
    const { guard, pushed } = guardWith()
    const first = guard.allow({ value: big, details })
    const second = guard.allow({ value: big, details })
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    const ids = pushed.map((msg) => msg.id)

    guard.stop()
    await expect(first).rejects.toThrow(/not confirmed/)
    await expect(second).rejects.toThrow(/not confirmed/)
    for (const id of ids) expect(retracted(pushed, id)).toBe(true)
  })
})

describe('noticing that nobody is there', () => {
  it('locks and says so when the wallet has gone idle', () => {
    vi.useFakeTimers()
    try {
      const onAutoLock = vi.fn()
      const wallet = { lockIfIdle: vi.fn(() => true), verifyPassword: vi.fn(), touch: vi.fn() }
      const guard = createGuard({
        wallet,
        send: () => {},
        settings: () => ({}),
        onAutoLock
      })

      guard.watchIdle()
      vi.advanceTimersByTime(15 * 1000)

      expect(wallet.lockIfIdle).toHaveBeenCalled()
      expect(onAutoLock).toHaveBeenCalledTimes(1)
      guard.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing while somebody is still using it', () => {
    vi.useFakeTimers()
    try {
      const onAutoLock = vi.fn()
      const guard = createGuard({
        wallet: { lockIfIdle: () => false, verifyPassword: vi.fn(), touch: vi.fn() },
        send: () => {},
        settings: () => ({}),
        onAutoLock
      })

      guard.watchIdle()
      vi.advanceTimersByTime(10 * 60 * 1000)

      expect(onAutoLock).not.toHaveBeenCalled()
      guard.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a second timer when asked twice', () => {
    vi.useFakeTimers()
    try {
      const onAutoLock = vi.fn()
      const guard = createGuard({
        wallet: { lockIfIdle: () => true, verifyPassword: vi.fn(), touch: vi.fn() },
        send: () => {},
        settings: () => ({}),
        onAutoLock
      })

      guard.watchIdle()
      guard.watchIdle()
      vi.advanceTimersByTime(15 * 1000)

      expect(onAutoLock).toHaveBeenCalledTimes(1)
      guard.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
