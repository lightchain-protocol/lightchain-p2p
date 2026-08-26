import { describe, expect, it, vi } from 'vitest'
import { ROOM_MINIMUM, createHolding } from '../workers/services/holding.mjs'

/**
 * The condition on making a room.
 *
 * The rule worth protecting here is the one that is easy to get backwards: an
 * unreachable endpoint must not read as an empty wallet. Failing closed on a
 * balance nobody could read would make a peer-to-peer application stop working
 * whenever a web endpoint did, and would be indistinguishable, to whoever is
 * looking at it, from being told they hold nothing.
 */

const ADDRESS = '0x' + 'ab'.repeat(20)

function gate({ balance = ROOM_MINIMUM, unlocked = true, enforced = true, throws = null } = {}) {
  const balanceOf = vi.fn(async () => {
    if (throws) throw throws
    return balance
  })

  const holding = createHolding({
    rpc: () => ({ balanceOf }),
    wallet: { status: () => ({ unlocked, address: unlocked ? ADDRESS : null }) },
    network: () => 'mainnet',
    enforced
  })

  return { holding, balanceOf }
}

describe('the balance it asks for', () => {
  it('allows a wallet holding exactly the minimum', async () => {
    const { holding } = gate({ balance: ROOM_MINIMUM })
    await expect(holding.check()).resolves.toMatchObject({ ok: true, reason: 'holds' })
  })

  it('refuses one a single wei short', async () => {
    const { holding } = gate({ balance: ROOM_MINIMUM - 1n })
    const verdict = await holding.check()
    expect(verdict).toMatchObject({ ok: false, reason: 'short' })
    // Both figures travel, because the dialog says what is held against what
    // is needed and cannot ask a second time to find out.
    expect(verdict.balance).toBe((ROOM_MINIMUM - 1n).toString())
    expect(verdict.minimum).toBe(ROOM_MINIMUM.toString())
  })

  it('refuses an empty wallet', async () => {
    const { holding } = gate({ balance: 0n })
    await expect(holding.check()).resolves.toMatchObject({ ok: false, reason: 'short' })
  })
})

describe('a failure is never a zero', () => {
  it('allows the room when the balance could not be read', async () => {
    const { holding } = gate({ throws: new Error('endpoint down') })
    await expect(holding.check()).resolves.toMatchObject({
      ok: true,
      reason: 'unreadable',
      balance: null
    })
  })

  it('does not cache an outage', async () => {
    const balanceOf = vi
      .fn()
      .mockRejectedValueOnce(new Error('endpoint down'))
      .mockResolvedValueOnce(ROOM_MINIMUM)

    const holding = createHolding({
      rpc: () => ({ balanceOf }),
      wallet: { status: () => ({ unlocked: true, address: ADDRESS }) },
      network: () => 'mainnet'
    })

    await expect(holding.check()).resolves.toMatchObject({ reason: 'unreadable' })
    // Without this the next fifteen seconds inherit the outage, and somebody
    // who just funded the wallet is told to wait for a timer they cannot see.
    await expect(holding.check()).resolves.toMatchObject({ reason: 'holds' })
    expect(balanceOf).toHaveBeenCalledTimes(2)
  })

  it('reuses a readable verdict rather than asking every click', async () => {
    const { holding, balanceOf } = gate({ balance: ROOM_MINIMUM })
    await holding.check()
    await holding.check()
    expect(balanceOf).toHaveBeenCalledTimes(1)
  })

  it('asks again once the wallet is a different one', async () => {
    let address = ADDRESS
    const balanceOf = vi.fn(async () => ROOM_MINIMUM)
    const holding = createHolding({
      rpc: () => ({ balanceOf }),
      wallet: { status: () => ({ unlocked: true, address }) },
      network: () => 'mainnet'
    })

    await holding.check()
    address = '0x' + 'cd'.repeat(20)
    await holding.check()
    expect(balanceOf).toHaveBeenCalledTimes(2)
  })
})

describe('what it never gates', () => {
  it('says nothing at all when the gate is off', async () => {
    const { holding, balanceOf } = gate({ balance: 0n, enforced: false })
    await expect(holding.check()).resolves.toMatchObject({ ok: true, reason: 'off' })
    // An RPC round trip for a question already answered is a round trip that
    // can fail, which is the whole reason the flag exists.
    expect(balanceOf).not.toHaveBeenCalled()
  })

  it('refuses a locked wallet, because there is no address to read', async () => {
    const { holding } = gate({ unlocked: false })
    await expect(holding.check()).resolves.toMatchObject({ ok: false, reason: 'locked' })
  })
})

describe('require', () => {
  it('passes the verdict through when the wallet holds enough', async () => {
    const { holding } = gate({ balance: ROOM_MINIMUM * 2n })
    await expect(holding.require()).resolves.toMatchObject({ ok: true })
  })

  it('names the amount rather than a code', async () => {
    const { holding } = gate({ balance: 0n })
    await expect(holding.require()).rejects.toThrow(/at least 1 LCAI/)
  })

  it('says to unlock when that is the actual problem', async () => {
    const { holding } = gate({ unlocked: false })
    await expect(holding.require()).rejects.toThrow(/unlock the wallet/)
  })

  it('lets the room through when the chain could not be reached', async () => {
    const { holding } = gate({ throws: new Error('endpoint down') })
    await expect(holding.require()).resolves.toMatchObject({ reason: 'unreadable' })
  })
})
