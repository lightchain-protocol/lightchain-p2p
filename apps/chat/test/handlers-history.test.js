import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The history handler's honesty tests.
 *
 * What an address has done is assembled from three sources of very different
 * completeness, and the value of this handler is not the list — it is the
 * `covers`/`blindTo` pair that says what the list cannot see. A history screen
 * that quietly omits incoming native transfers makes somebody think they were
 * not paid, so the failure paths here matter as much as the happy ones: every
 * refusal and every degraded answer is exercised with the network replaced by
 * a fetch mock and the chain replaced by an answer-per-call pool.
 */

const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('bare-fetch', () => ({ default: mockFetch }))

import { TRANSFER_TOPIC } from '@lcai-p2p/chain'
import { historyHandlers } from '../workers/handlers/history.mjs'

const ADDRESS = `0x${'11'.repeat(20)}`
const MINE = `0x${'0'.repeat(24)}${'11'.repeat(20)}`
const OTHER = `0x${'22'.repeat(20)}`
const HASH = `0x${'ab'.repeat(32)}`

/** The combined-filter URL the explorer is first asked, and the fallback. */
const FILTERED = `https://mainnet.lightscan.app/api/v2/addresses/${ADDRESS}/transactions?filter=to%20%7C%20from`
const UNFILTERED = `https://mainnet.lightscan.app/api/v2/addresses/${ADDRESS}/transactions`

const explorerOk = (items) => ({ ok: true, status: 200, json: async () => ({ items }) })
const explorerBad = (status = 502) => ({ ok: false, status, json: async () => ({}) })

function ctxWith({ address = ADDRESS, pool = null } = {}) {
  return {
    wallet: { status: () => ({ address }) },
    poolFor: vi.fn(() => pool)
  }
}

/** An RPC pool that answers eth_getLogs by which indexed topic is ours. */
function poolWith({ incoming = [], outgoing = [], latest = 1_000n, sendImpl = null } = {}) {
  return {
    blockNumber: vi.fn(async () => latest),
    send: vi.fn(async (method, [filter]) => {
      if (sendImpl) return sendImpl(method, filter)
      if (method !== 'eth_getLogs') throw new Error(`unexpected call: ${method}`)
      if (filter.topics[1] === MINE) return outgoing
      if (filter.topics[2] === MINE) return incoming
      return []
    })
  }
}

const transferLog = ({ from = OTHER, to = ADDRESS, value = 10n, block = 100n, logIndex = null } = {}) => ({
  transactionHash: HASH,
  topics: [
    TRANSFER_TOPIC,
    `0x${'0'.repeat(24)}${from.slice(2)}`,
    `0x${'0'.repeat(24)}${to.slice(2)}`
  ],
  data: `0x${value.toString(16).padStart(64, '0')}`,
  blockNumber: `0x${block.toString(16)}`,
  // Only present when a test says so: plenty of nodes omit it, and the dedup
  // has to hold either way.
  ...(logIndex === null ? {} : { logIndex: `0x${logIndex.toString(16)}` })
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the gate in front of either source', () => {
  it('refuses a locked wallet before asking anything', async () => {
    const ctx = ctxWith({ address: null, pool: poolWith() })
    const handlers = historyHandlers(ctx)

    await expect(handlers['history.forAsset']({ chainId: 9200 })).rejects.toThrow(
      /unlock the wallet/
    )
    expect(mockFetch).not.toHaveBeenCalled()
    expect(ctx.poolFor).not.toHaveBeenCalled()
  })

  it('refuses a chain this wallet does not know', async () => {
    const handlers = historyHandlers(ctxWith({ pool: poolWith() }))

    await expect(handlers['history.forAsset']({ chainId: 999999 })).rejects.toThrow(
      /does not know that chain/
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('the Lightchain explorer path', () => {
  it('maps explorer items into entries with direction and status', async () => {
    mockFetch.mockResolvedValue(
      explorerOk([
        {
          hash: HASH,
          timestamp: '2026-01-01T00:00:00Z',
          from: { hash: ADDRESS },
          to: { hash: OTHER },
          value: '42',
          status: 'ok',
          method: 'transfer',
          block_number: 7
        },
        {
          hash: `0x${'cd'.repeat(32)}`,
          timestamp: 'not a date',
          from: { hash: OTHER },
          to: { hash: ADDRESS },
          value: '5',
          status: 'error',
          block_number: 9
        }
      ])
    )
    const handlers = historyHandlers(ctxWith())

    const history = await handlers['history.forAsset']({ chainId: 9200 })

    expect(history.source).toBe('explorer')
    expect(history.blindTo).toBeNull()
    expect(history.covers).toMatch(/everything this address has done/i)
    expect(history.entries).toEqual([
      {
        hash: HASH,
        at: Date.parse('2026-01-01T00:00:00Z'),
        from: ADDRESS,
        to: OTHER,
        value: '42',
        symbol: 'LCAI',
        decimals: 18,
        direction: 'out',
        status: 'confirmed',
        method: 'transfer',
        block: 7
      },
      {
        hash: `0x${'cd'.repeat(32)}`,
        at: null,
        from: OTHER,
        to: ADDRESS,
        value: '5',
        symbol: 'LCAI',
        decimals: 18,
        direction: 'in',
        status: 'failed',
        method: null,
        block: 9
      }
    ])
    expect(mockFetch).toHaveBeenCalledWith(FILTERED, { headers: { accept: 'application/json' } })
  })

  it('falls back to the unfiltered query when the combined filter is rejected', async () => {
    // Some Blockscout versions refuse `filter=to | from`; the fallback is
    // everything, not nothing.
    mockFetch.mockResolvedValueOnce(explorerBad(400)).mockResolvedValueOnce(explorerOk([]))
    const handlers = historyHandlers(ctxWith())

    const history = await handlers['history.forAsset']({ chainId: 9200 })

    expect(history.source).toBe('explorer')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(1, FILTERED, expect.anything())
    expect(mockFetch).toHaveBeenNthCalledWith(2, UNFILTERED, expect.anything())
  })

  it('answers source:none with the reason when the explorer is down', async () => {
    mockFetch.mockResolvedValue(explorerBad(502))
    const handlers = historyHandlers(ctxWith())

    const history = await handlers['history.forAsset']({ chainId: 9200 })

    expect(history.source).toBe('none')
    expect(history.entries).toEqual([])
    expect(history.blindTo).toMatch(/could not be reached/)
    expect(history.blindTo).toMatch(/answered 502/)
    // The reassurance is part of the contract: the balance is not in doubt.
    expect(history.blindTo).toMatch(/nothing is missing from your balance/i)
  })

  it('answers source:none rather than throwing when the network itself fails', async () => {
    mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    const handlers = historyHandlers(ctxWith())

    const history = await handlers['history.forAsset']({ chainId: 9200 })

    expect(history.source).toBe('none')
    expect(history.blindTo).toMatch(/ENOTFOUND/)
  })

  it('takes the log path even on Lightchain when a token is named', async () => {
    // The explorer answer covers native transfers of the address; a token
    // history is a log scan everywhere, Lightchain included.
    const pool = poolWith({ incoming: [transferLog({ value: 10n })] })
    const handlers = historyHandlers(ctxWith({ pool }))

    const history = await handlers['history.forAsset']({
      chainId: 9200,
      token: `0x${'55'.repeat(20)}`,
      symbol: 'USDT',
      decimals: 6
    })

    expect(mockFetch).not.toHaveBeenCalled()
    expect(history.source).toBe('logs')
    expect(history.entries[0]).toMatchObject({ symbol: 'USDT', decimals: 6, direction: 'in' })
  })
})

describe('the log-scan path', () => {
  it('decodes ERC-20 Transfer logs and says what logs cannot see', async () => {
    const pool = poolWith({
      incoming: [transferLog({ value: 10n, block: 100n })],
      outgoing: [transferLog({ from: ADDRESS, to: OTHER, value: 3n, block: 120n })]
    })
    const handlers = historyHandlers(ctxWith({ pool }))

    const history = await handlers['history.forAsset']({ chainId: 1 })

    expect(history.source).toBe('logs')
    // Newest block first.
    expect(history.entries).toEqual([
      {
        hash: HASH,
        at: null,
        from: ADDRESS,
        to: OTHER,
        value: '3',
        symbol: 'token',
        decimals: 18,
        direction: 'out',
        status: 'confirmed',
        method: 'transfer',
        block: 120
      },
      {
        hash: HASH,
        at: null,
        from: OTHER,
        to: ADDRESS,
        value: '10',
        symbol: 'token',
        decimals: 18,
        direction: 'in',
        status: 'confirmed',
        method: 'transfer',
        block: 100
      }
    ])
    // The honest half of the reply: native transfers emit no event, and the
    // reply must say so rather than imply completeness.
    expect(history.blindTo).toMatch(/transfers of ETH itself do not appear here/i)
  })

  it('asks both indexed directions, from me and to me', async () => {
    const pool = poolWith()
    const handlers = historyHandlers(ctxWith({ pool }))

    await handlers['history.forAsset']({ chainId: 1 })

    const topics = pool.send.mock.calls.map(([, [filter]]) => filter.topics)
    expect(topics).toEqual([
      [TRANSFER_TOPIC, MINE, null],
      [TRANSFER_TOPIC, null, MINE]
    ])
  })

  it('halves the scan window when the provider refuses the range', async () => {
    // Providers signal "too much" in four shapes; the one response that works
    // for all of them is halving. 200k blocks back fails, 100k succeeds.
    const pool = poolWith({ latest: 200_000n })
    pool.send.mockRejectedValueOnce(new Error('query exceeds max block range'))
    const handlers = historyHandlers(ctxWith({ pool }))

    const history = await handlers['history.forAsset']({ chainId: 1 })

    expect(history.source).toBe('logs')
    const fromBlocks = pool.send.mock.calls.map(([, [filter]]) => BigInt(filter.fromBlock))
    expect(fromBlocks[0]).toBe(100_000n)
    expect(fromBlocks[1]).toBe(150_000n)
  })

  it('answers source:none with the chain named when the node cannot be asked', async () => {
    const pool = { blockNumber: vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))) }
    const handlers = historyHandlers(ctxWith({ pool }))

    const history = await handlers['history.forAsset']({ chainId: 1 })

    expect(history.source).toBe('none')
    expect(history.entries).toEqual([])
    expect(history.blindTo).toMatch(/Ethereum could not be asked/)
    expect(history.blindTo).toMatch(/ECONNREFUSED/)
  })

  it('lists a self-transfer once, though it matches both direction queries', async () => {
    // A transfer from this address to itself matches both indexed topics, so
    // both queries return it. It is one transfer: the dedup by transaction and
    // log is what keeps the list honest.
    const pool = poolWith({
      incoming: [transferLog({ from: ADDRESS, to: ADDRESS, value: 7n })],
      outgoing: [transferLog({ from: ADDRESS, to: ADDRESS, value: 7n })]
    })
    const handlers = historyHandlers(ctxWith({ pool }))

    const history = await handlers['history.forAsset']({ chainId: 1 })

    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({ value: '7', from: ADDRESS, to: ADDRESS })
  })

  it('keeps two transfers that share a transaction but are different logs', async () => {
    // One transaction can move a token twice — a contract splitting a payment,
    // say. The dedup keys on the log, not the hash, so both survive.
    const pool = poolWith({
      incoming: [transferLog({ value: 10n, logIndex: 0 }), transferLog({ value: 5n, logIndex: 1 })]
    })
    const handlers = historyHandlers(ctxWith({ pool }))

    const history = await handlers['history.forAsset']({ chainId: 1 })

    expect(history.entries.map((entry) => entry.value).sort()).toEqual(['10', '5'])
  })
})
