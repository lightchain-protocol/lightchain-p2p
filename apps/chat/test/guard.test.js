import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIRM_ABOVE,
  DEFAULT_REAUTH_ABOVE,
  createGuard,
  readableAmount
} from '../workers/guard.mjs'

/**
 * The checks between a compromised window and somebody's money.
 *
 * Worth testing here rather than only through the interface, because every
 * failure mode has to fail closed and most of them are unreachable from a
 * harness: a dialog nobody answers, a main process that never replies, a
 * malformed line on the pipe. Each of those must refuse, and none of them can
 * be produced by clicking.
 */

const ONE = 10n ** 18n

function guardWith({ password = 'right', values = {} } = {}) {
  const written = []
  const wallet = {
    verifyPassword: vi.fn((given) => given === password),
    lockIfIdle: vi.fn(() => false),
    touch: vi.fn()
  }

  const guard = createGuard({
    wallet,
    pipe: { write: (line) => written.push(line) },
    settings: () => values,
    onAutoLock: vi.fn()
  })

  /** Answers the most recent dialog the way a person would. */
  const answer = (approved) => {
    const line = written.findLast((l) => l.startsWith('wallet:confirm '))
    const { id } = JSON.parse(line.slice('wallet:confirm'.length))
    guard.handleLine(`wallet:confirmed ${JSON.stringify({ id, approved })}`)
  }

  return { guard, wallet, written, answer }
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
    const { guard, wallet, written } = guardWith()
    await expect(guard.allow({ value: 1n, details })).resolves.toBeUndefined()

    expect(wallet.verifyPassword).not.toHaveBeenCalled()
    expect(written).toHaveLength(0)
  })
})

describe('amounts past the password threshold', () => {
  it('are refused without one', async () => {
    const { guard } = guardWith()
    await expect(guard.allow({ value: DEFAULT_REAUTH_ABOVE, details })).rejects.toThrow(
      /needs your password/
    )
  })

  it('are refused on a wrong one', async () => {
    const { guard } = guardWith()
    await expect(
      guard.allow({ value: DEFAULT_REAUTH_ABOVE, password: 'wrong', details })
    ).rejects.toThrow(/not right/)
  })

  it('go through on the right one', async () => {
    const { guard } = guardWith()
    await expect(
      guard.allow({ value: DEFAULT_REAUTH_ABOVE, password: 'right', details })
    ).resolves.toBeUndefined()
  })

  it('take the threshold from settings when one is set', async () => {
    const { guard, wallet } = guardWith({ values: { reauthAboveWei: '5' } })

    await expect(guard.allow({ value: 4n, details })).resolves.toBeUndefined()
    expect(wallet.verifyPassword).not.toHaveBeenCalled()

    await expect(guard.allow({ value: 5n, details })).rejects.toThrow(/needs your password/)
  })

  it('ignore a threshold that is not a number, rather than trusting it', async () => {
    // A settings file that has been edited into nonsense must make the checks
    // stricter, never weaker. Falling back to the default does that.
    for (const bad of ['', 'lots', '-1', '1.5', null, {}]) {
      const { guard } = guardWith({ values: { reauthAboveWei: bad } })
      await expect(guard.allow({ value: DEFAULT_REAUTH_ABOVE, details })).rejects.toThrow(
        /needs your password/
      )
    }
  })
})

describe('amounts past the dialog threshold', () => {
  const big = DEFAULT_CONFIRM_ABOVE

  it('ask the operating system, describing the transfer', async () => {
    const { guard, written, answer } = guardWith()
    const allowed = guard.allow({ value: big, password: 'right', details })

    await vi.waitFor(() => expect(written).toHaveLength(1))
    const asked = JSON.parse(written[0].slice('wallet:confirm'.length))
    expect(asked).toMatchObject(details)
    expect(asked.id).toBeTruthy()

    answer(true)
    await expect(allowed).resolves.toBeUndefined()
  })

  it('refuse when the answer is no', async () => {
    const { guard, written, answer } = guardWith()
    const allowed = guard.allow({ value: big, password: 'right', details })

    await vi.waitFor(() => expect(written).toHaveLength(1))
    answer(false)
    await expect(allowed).rejects.toThrow(/not confirmed/)
  })

  it('still want the password first', async () => {
    const { guard, written } = guardWith()
    await expect(guard.allow({ value: big, details })).rejects.toThrow(/needs your password/)
    expect(written).toHaveLength(0)
  })

  it('refuse when nobody ever answers', async () => {
    vi.useFakeTimers()
    try {
      const { guard } = guardWith()
      const allowed = guard.allow({ value: big, password: 'right', details })
      const settled = expect(allowed).rejects.toThrow(/not confirmed/)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuse when the reply cannot be read', async () => {
    vi.useFakeTimers()
    try {
      const { guard } = guardWith()
      const allowed = guard.allow({ value: big, password: 'right', details })
      const settled = expect(allowed).rejects.toThrow(/not confirmed/)

      expect(guard.handleLine('wallet:confirmed not json at all')).toBe(true)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignore an answer to a question nobody asked', () => {
    const { guard } = guardWith()
    expect(guard.handleLine('wallet:confirmed {"id":"999","approved":true}')).toBe(true)
  })

  it('refuse everything outstanding when the worker shuts down', async () => {
    const { guard, written } = guardWith()
    const allowed = guard.allow({ value: big, password: 'right', details })

    await vi.waitFor(() => expect(written).toHaveLength(1))
    guard.stop()
    await expect(allowed).rejects.toThrow(/not confirmed/)
  })
})

describe('the line reader', () => {
  it('claims only the replies it owns', () => {
    const { guard } = guardWith()
    expect(guard.handleLine('{"t":"ok"}')).toBe(false)
    expect(guard.handleLine('pear:applyUpdate')).toBe(false)
    expect(guard.handleLine('wallet:confirmed {"id":"1","approved":true}')).toBe(true)
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
        pipe: { write: () => {} },
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
        pipe: { write: () => {} },
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
        pipe: { write: () => {} },
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
