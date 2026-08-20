import { describe, expect, it, vi } from 'vitest'
import { BRIDGE } from '@lcai-p2p/chain'
import { DISPATCH_ID_TOPIC, bridgeHandlers, dispatchIdFromLogs } from '../workers/handlers/bridge.mjs'

/**
 * The bridge's send-time checks, driven without a chain.
 *
 * The allowance a transfer will pull against is re-read at send time rather
 * than trusted from the quote the window showed: approve and send are
 * separate transactions at separate moments, and between them the allowance
 * can have been spent, replaced, or never have landed. Finding that out on
 * chain costs the gas of a reverted `transferRemote`.
 */

const ADDRESS = `0x${'1'.repeat(40)}`
const AMOUNT = '1000'

function ctxWith({ allowed }) {
  const rpc = {
    call: async ({ to }) =>
      // Allowance questions go to the token; the quote goes to the router. An
      // empty answer decodes to { native: 0, token: amount }, the route's
      // honest answer today.
      to.toLowerCase() === BRIDGE.ethereumToken.toLowerCase()
        ? `0x${allowed.toString(16).padStart(64, '0')}`
        : '0x'
  }

  const guard = { allow: vi.fn(async () => {}) }

  return {
    guard,
    ctx: {
      wallet: { status: () => ({ address: ADDRESS }) },
      localState: {
        read: (name, empty) => (name === 'bridge' ? { acknowledged: true } : empty),
        write: () => {}
      },
      poolFor: () => ({ use: (work) => work(rpc), balanceOf: async () => 0n }),
      guard
    }
  }
}

describe('bridge.send re-reading the allowance', () => {
  it('refuses when no approval ever landed', async () => {
    const { ctx, guard } = ctxWith({ allowed: 0n })
    const handlers = bridgeHandlers(ctx)

    await expect(handlers['bridge.send']({ fromChainId: 1, amount: AMOUNT })).rejects.toThrow(
      /approve the router/i
    )
    // Refused before anything is put to the operating system, let alone signed.
    expect(guard.allow).not.toHaveBeenCalled()
  })

  it('refuses when the allowance covers an older, smaller amount', async () => {
    const { ctx, guard } = ctxWith({ allowed: 500n })
    const handlers = bridgeHandlers(ctx)

    await expect(handlers['bridge.send']({ fromChainId: 1, amount: AMOUNT })).rejects.toThrow(
      /approve the router/i
    )
    expect(guard.allow).not.toHaveBeenCalled()
  })

  it('does not ask for an approval on the native route', async () => {
    // Lightchain → Ethereum sends the coin as value and pulls nothing. The
    // check must not fire there; the guard is reached, which is as far as a
    // chainless test can honestly go.
    const { ctx, guard } = ctxWith({ allowed: 0n })
    const handlers = bridgeHandlers(ctx)

    await expect(
      handlers['bridge.send']({ fromChainId: 9200, amount: AMOUNT })
    ).rejects.toThrow()
    expect(guard.allow).toHaveBeenCalledOnce()
  })
})

describe('the DispatchId a transfer was assigned', () => {
  const MESSAGE_ID = `0x${'ab'.repeat(32)}`

  it('has the topic Hyperlane publishes for DispatchId(bytes32)', () => {
    // A regression pin: the constant is hashed from the signature at module
    // load, and this is the value that hash must be.
    expect(DISPATCH_ID_TOPIC).toBe(
      '0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a'
    )
  })

  it('reads the message id out of the receipt logs', () => {
    const logs = [
      { topics: [`0x${'00'.repeat(32)}`], data: '0x' },
      { topics: [DISPATCH_ID_TOPIC, MESSAGE_ID], data: '0x' }
    ]
    expect(dispatchIdFromLogs(logs)).toBe(MESSAGE_ID)
  })

  it('answers null when the logs carry none', () => {
    expect(dispatchIdFromLogs([])).toBe(null)
    expect(dispatchIdFromLogs([{ topics: [`0x${'00'.repeat(32)}`] }])).toBe(null)
    expect(dispatchIdFromLogs(undefined)).toBe(null)
  })
})
