import { describe, expect, it, vi } from 'vitest'

/**
 * A chain registry that can be told to forget a chain, so the defensive half
 * of route resolution — the registry having dropped a chain the bridge runs
 * on — is exercised rather than assumed. Empty by default: every import below
 * behaves exactly as the real module unless a test drops a chain.
 */
const registryState = vi.hoisted(() => ({ drop: new Set() }))

vi.mock('@lcai-p2p/chain', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    chainById: (id) => (registryState.drop.has(id) ? null : actual.chainById(id))
  }
})

import {
  BRIDGE,
  ETHEREUM_DOMAIN,
  LIGHTCHAIN_DOMAIN,
  LCAI_MAINNET,
  TOKENS,
  allowanceCall,
  balanceOfCall,
  chainById,
  quoteTransferRemoteCall
} from '@lcai-p2p/chain'
import { bridgeHandlers } from '../workers/handlers/bridge.mjs'

/**
 * Which way round a bridge transfer goes, and everything that follows from it.
 *
 * `routeFor` is not exported — it is exercised through the handlers that plan
 * from it, at the same seams the other bridge suites use: the wallet, the
 * local store, the pool and the guard. The chain itself is never touched: the
 * mock RPC answers `eth_call` by which contract the question went to, which is
 * exactly the routing decision under test.
 *
 * What is deliberately not here: the allowance re-read at send time
 * (bridge-send.test.js), the in-flight transfer store (bridge-pending.test.js),
 * the approval sequencing (approvals.test.js), and the raw address pins of the
 * BRIDGE constants (packages/chain/src/hyperlane.test.ts).
 */

const ADDRESS = `0x${'1'.repeat(40)}`
const AMOUNT = '1000'

const word = (value) => `0x${value.toString(16).padStart(64, '0')}`

function ctxWith({ allowed = 0n, held = 0n, nativeBalance = 0n } = {}) {
  /** Every eth_call, as `{ to, data }` — the record of which contract was asked what. */
  const calls = []
  /** The chain ids the planner pooled, in order. */
  const pooled = []
  /** The chain ids a native balance was read on. */
  const nativeReads = []

  const rpc = {
    call: async (request) => {
      calls.push(request)
      if (request.to.toLowerCase() === BRIDGE.ethereumToken.toLowerCase()) {
        if (request.data === allowanceCall(ADDRESS, BRIDGE.ethereumRouter)) return word(allowed)
        if (request.data === balanceOfCall(ADDRESS)) return word(held)
      }
      // The quote, and anything else: an empty answer, which decodes to
      // { native: 0, token: amount } — the route's honest answer today.
      return '0x'
    }
  }

  const guard = { allow: vi.fn(async () => {}) }

  return {
    calls,
    pooled,
    nativeReads,
    guard,
    ctx: {
      wallet: { status: () => ({ address: ADDRESS }) },
      localState: {
        read: (name, empty) => (name === 'bridge' ? { acknowledged: true } : empty),
        write: () => {}
      },
      poolFor: (chainId) => {
        pooled.push(chainId)
        return {
          use: (work) => work(rpc),
          balanceOf: async () => {
            nativeReads.push(chainId)
            return nativeBalance
          }
        }
      },
      guard
    }
  }
}

const callsTo = (calls, address) =>
  calls.filter((call) => call.to.toLowerCase() === address.toLowerCase())

describe('the route a source chain resolves to', () => {
  it('locks the ERC-20 on Ethereum and releases the native coin on Lightchain', async () => {
    const { ctx, calls, pooled, nativeReads } = ctxWith({ held: 10_000n, nativeBalance: 10_000n })
    const handlers = bridgeHandlers(ctx)

    const quote = await handlers['bridge.quote']({ fromChainId: 1, amount: AMOUNT })

    // The source chain is pooled, and the router asked is the collateral
    // router the documentation pins on Ethereum.
    expect(pooled).toEqual([ETHEREUM_DOMAIN])
    expect(callsTo(calls, BRIDGE.ethereumRouter)).toEqual([
      { to: BRIDGE.ethereumRouter, data: quoteTransferRemoteCall(LIGHTCHAIN_DOMAIN, ADDRESS, 1000n) }
    ])

    // The token that locks is asked for the balance and for the allowance the
    // router would pull against — both on the documented LCAI contract.
    const tokenCalls = callsTo(calls, BRIDGE.ethereumToken).map((call) => call.data)
    expect(tokenCalls).toContain(balanceOfCall(ADDRESS))
    expect(tokenCalls).toContain(allowanceCall(ADDRESS, BRIDGE.ethereumRouter))

    // The native coin still pays gas, so its balance is read even though the
    // thing being bridged is a token.
    expect(nativeReads).toEqual([ETHEREUM_DOMAIN])

    expect(quote).toMatchObject({
      fromChainId: ETHEREUM_DOMAIN,
      fromName: 'Ethereum',
      toChainId: LIGHTCHAIN_DOMAIN,
      toName: 'Lightchain',
      amount: AMOUNT,
      nativeFee: '0',
      approve: AMOUNT,
      needsApproval: true,
      allowance: '0',
      enough: true,
      acknowledged: true,
      recipient: ADDRESS
    })
  })

  it('sends the native coin on Lightchain and unlocks the ERC-20 on Ethereum', async () => {
    const { ctx, calls, pooled, nativeReads } = ctxWith({ nativeBalance: 10_000n })
    const handlers = bridgeHandlers(ctx)

    const quote = await handlers['bridge.quote']({ fromChainId: 9200, amount: AMOUNT })

    expect(pooled).toEqual([LIGHTCHAIN_DOMAIN])
    expect(callsTo(calls, BRIDGE.lightchainRouter)).toEqual([
      { to: BRIDGE.lightchainRouter, data: quoteTransferRemoteCall(ETHEREUM_DOMAIN, ADDRESS, 1000n) }
    ])

    // Nothing to pull, so nothing to approve: the token contract is never
    // asked anything, and the balance comes from the native read.
    expect(callsTo(calls, BRIDGE.ethereumToken)).toEqual([])
    expect(nativeReads).toEqual([LIGHTCHAIN_DOMAIN])

    expect(quote).toMatchObject({
      fromChainId: LIGHTCHAIN_DOMAIN,
      fromName: 'Lightchain',
      toChainId: ETHEREUM_DOMAIN,
      toName: 'Ethereum',
      needsApproval: false,
      allowance: '0',
      enough: true
    })
  })

  it('does not ask for an approval the allowance already covers', async () => {
    const { ctx } = ctxWith({ allowed: 1000n, held: 10_000n, nativeBalance: 10_000n })
    const handlers = bridgeHandlers(ctx)

    const quote = await handlers['bridge.quote']({ fromChainId: 1, amount: AMOUNT })

    expect(quote.needsApproval).toBe(false)
    expect(quote.allowance).toBe(AMOUNT)
  })
})

describe('chains the bridge refuses', () => {
  function refusingCtx() {
    return bridgeHandlers({
      wallet: { status: () => ({ address: ADDRESS }) },
      localState: {
        read: (name, empty) => (name === 'bridge' ? { acknowledged: true } : empty),
        write: () => {}
      },
      poolFor: () => {
        throw new Error('no chain should be pooled for a route the bridge does not run')
      },
      guard: { allow: async () => {} }
    })
  }

  it.each([
    ['a chain the wallet knows but the bridge does not serve', 8453],
    ['the Lightchain testnet', 8200],
    ['no chain at all', undefined],
    ['a chain id that is not a number', 'one'],
    ['the null chain', 0]
  ])('refuses %s before any chain is pooled', async (_label, fromChainId) => {
    const handlers = refusingCtx()

    await expect(handlers['bridge.quote']({ fromChainId, amount: AMOUNT })).rejects.toThrow(
      /only runs between Ethereum and Lightchain/
    )
    await expect(handlers['bridge.send']({ fromChainId, amount: AMOUNT })).rejects.toThrow(
      /only runs between Ethereum and Lightchain/
    )
  })

  it('accepts the chain id as a string, the way a window would send it', async () => {
    const { ctx, pooled } = ctxWith({ nativeBalance: 10_000n })
    const handlers = bridgeHandlers(ctx)

    const quote = await handlers['bridge.quote']({ fromChainId: '9200', amount: AMOUNT })

    expect(pooled).toEqual([LIGHTCHAIN_DOMAIN])
    expect(quote.fromChainId).toBe(LIGHTCHAIN_DOMAIN)
  })
})

describe('a registry that dropped a chain the bridge runs on', () => {
  async function withDroppedChain(domain, run) {
    registryState.drop.add(domain)
    try {
      await run()
    } finally {
      registryState.drop.clear()
    }
  }

  it('fails a quote with a plain message, not a TypeError from a null deref', async () => {
    await withDroppedChain(LIGHTCHAIN_DOMAIN, async () => {
      const { ctx } = ctxWith({ held: 10_000n, nativeBalance: 10_000n })
      const handlers = bridgeHandlers(ctx)

      const failure = await handlers['bridge.quote']({ fromChainId: 1, amount: AMOUNT }).catch(
        (err) => err
      )

      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(TypeError)
      expect(failure.message).toMatch(/missing from the chain registry/)
    })
  })

  it('fails a send the same way, whichever side of the route went missing', async () => {
    await withDroppedChain(ETHEREUM_DOMAIN, async () => {
      const { ctx } = ctxWith({ nativeBalance: 10_000n })
      const handlers = bridgeHandlers(ctx)

      const failure = await handlers['bridge.send']({ fromChainId: 9200, amount: AMOUNT }).catch(
        (err) => err
      )

      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(TypeError)
      expect(failure.message).toMatch(/missing from the chain registry/)
    })
  })

  it('fails the terms screen plainly too, rather than advertising a broken route', async () => {
    await withDroppedChain(LIGHTCHAIN_DOMAIN, async () => {
      const { ctx } = ctxWith()
      const handlers = bridgeHandlers(ctx)

      expect(() => handlers['bridge.terms']()).toThrow(/missing from the chain registry/)
    })
  })
})

describe('the route shape the rest of the flow consumes', () => {
  it('finds nothing to approve on the native route', async () => {
    const { ctx, guard, pooled } = ctxWith()
    const handlers = bridgeHandlers(ctx)

    await expect(handlers['bridge.approve']({ fromChainId: 9200, amount: AMOUNT })).rejects.toThrow(
      /nothing needs approving in that direction/
    )
    // Refused on the route's shape alone: no chain pooled, nothing signed.
    expect(pooled).toEqual([])
    expect(guard.allow).not.toHaveBeenCalled()
  })

  it('watches the ERC-20 balance when the transfer arrives on Ethereum', async () => {
    const { ctx, calls, pooled, nativeReads } = ctxWith({ held: 7n })
    const handlers = bridgeHandlers(ctx)

    const arrival = await handlers['bridge.arrived']({ fromChainId: 9200, before: '0' })

    // Destination side: the Ethereum pool, and the token contract — the coin
    // that unlocks there is the ERC-20, not the native asset.
    expect(pooled).toEqual([ETHEREUM_DOMAIN])
    expect(callsTo(calls, BRIDGE.ethereumToken).map((call) => call.data)).toEqual([
      balanceOfCall(ADDRESS)
    ])
    expect(nativeReads).toEqual([])
    expect(arrival).toMatchObject({ chainId: ETHEREUM_DOMAIN, balance: '7', grew: true })
  })

  it('watches the native balance when the transfer arrives on Lightchain', async () => {
    const { ctx, calls, pooled, nativeReads } = ctxWith({ nativeBalance: 9n })
    const handlers = bridgeHandlers(ctx)

    const arrival = await handlers['bridge.arrived']({ fromChainId: 1, before: '9' })

    expect(pooled).toEqual([LIGHTCHAIN_DOMAIN])
    expect(nativeReads).toEqual([LIGHTCHAIN_DOMAIN])
    expect(calls).toEqual([])
    expect(arrival).toMatchObject({ chainId: LIGHTCHAIN_DOMAIN, balance: '9', grew: false })
  })

  it('advertises exactly the routes the planner accepts', async () => {
    const { ctx } = ctxWith({ held: 10_000n, nativeBalance: 10_000n })
    const handlers = bridgeHandlers(ctx)

    const { routes } = handlers['bridge.terms']()
    expect(routes).toEqual([
      {
        fromChainId: ETHEREUM_DOMAIN,
        fromName: 'Ethereum',
        toChainId: LIGHTCHAIN_DOMAIN,
        toName: 'Lightchain'
      },
      {
        fromChainId: LIGHTCHAIN_DOMAIN,
        fromName: 'Lightchain',
        toChainId: ETHEREUM_DOMAIN,
        toName: 'Ethereum'
      }
    ])

    // The terms table is derived from the planner's own route table, so an
    // advertised route the planner would refuse is impossible by construction —
    // and this test is the tripwire if that derivation is ever undone.
    for (const route of routes) {
      await expect(
        handlers['bridge.quote']({ fromChainId: route.fromChainId, amount: AMOUNT })
      ).resolves.toMatchObject({ fromChainId: route.fromChainId, toChainId: route.toChainId })
    }
  })
})

describe('the constants staying honest with the registries', () => {
  it('bridges the same LCAI the token and swap registries curate', () => {
    // Three modules hold an opinion on which contract is LCAI on Ethereum.
    // They were verified on chain independently; if they ever disagree, one of
    // the three is pointing a flow at the wrong contract.
    const curated = TOKENS.find(
      (token) => token.chainId === ETHEREUM_DOMAIN && token.symbol === 'LCAI'
    )
    expect(curated).toBeDefined()
    expect(BRIDGE.ethereumToken).toBe(curated.address)
    expect(BRIDGE.ethereumToken).toBe(LCAI_MAINNET)
  })

  it('resolves both bridge domains in the chain registry routeFor dereferences', () => {
    // routeFor reads .id, .name and .explorerUrl off these without a null
    // check. A registry that dropped either chain would turn a wrong-route
    // error into a TypeError on somebody's transfer — this is the hermetic
    // half of that guard.
    for (const domain of [ETHEREUM_DOMAIN, LIGHTCHAIN_DOMAIN]) {
      const chain = chainById(domain)
      expect(chain, `chain ${domain} must stay in the registry`).not.toBeNull()
      expect(chain.id).toBe(domain)
      expect(chain.explorerUrl).toMatch(/^https:\/\//)
    }
    expect(chainById(ETHEREUM_DOMAIN).name).toBe('Ethereum')
    expect(chainById(LIGHTCHAIN_DOMAIN).name).toBe('Lightchain')
  })

  it('keeps the two routers and the token as three different contracts', () => {
    // A copy-paste between these fields would lock funds in the wrong
    // contract, or bridge a chain to itself, and nothing on chain would say so.
    for (const address of [BRIDGE.ethereumRouter, BRIDGE.lightchainRouter, BRIDGE.ethereumToken]) {
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
    expect(BRIDGE.ethereumRouter.toLowerCase()).not.toBe(BRIDGE.lightchainRouter.toLowerCase())
    expect(BRIDGE.ethereumRouter.toLowerCase()).not.toBe(BRIDGE.ethereumToken.toLowerCase())
    expect(BRIDGE.lightchainRouter.toLowerCase()).not.toBe(BRIDGE.ethereumToken.toLowerCase())
  })
})
