import { afterEach, describe, expect, it, vi } from 'vitest'
import { FailoverRpc, RpcPool } from './pool.js'
import { Rpc, RpcError } from './rpc.js'
import { CHAINS, LIGHTCHAIN_DEVNET, LIGHTCHAIN_TESTNET, chainById } from './chains.js'

/**
 * The pool exists for one failure that has to be impossible.
 *
 * A balance read that fails and gets swallowed upstream renders as zero, and a
 * user cannot tell a zero balance caused by an outage from one caused by theft.
 * So the rule these check is not "the pool retries" — it is that the pool never
 * returns a number it did not receive from a node.
 */

const original = globalThis.fetch

afterEach(() => {
  globalThis.fetch = original
  vi.restoreAllMocks()
})

/** A fetch that answers according to a per-host script. */
function fetchThat(answers: Record<string, 'ok' | 'down' | 'revert'>, result = '0x1') {
  return vi.fn(async (url: string) => {
    const how = answers[String(url)] ?? 'down'
    if (how === 'down') throw new Error('connect ECONNREFUSED')

    if (how === 'revert') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: 3, message: 'execution reverted', data: '0x' }
        })
      }
    }

    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  })
}

const A = 'https://a.example'
const B = 'https://b.example'

describe('choosing an endpoint', () => {
  it('uses the first one that works', async () => {
    globalThis.fetch = fetchThat({ [A]: 'ok', [B]: 'ok' }) as never
    const pool = new RpcPool({ urls: [A, B] })

    expect(await pool.chainId()).toBe(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('steps over one that is down', async () => {
    globalThis.fetch = fetchThat({ [A]: 'down', [B]: 'ok' }) as never
    const pool = new RpcPool({ urls: [A, B] })

    expect(await pool.chainId()).toBe(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('refuses rather than inventing an answer when every endpoint is down', async () => {
    globalThis.fetch = fetchThat({ [A]: 'down', [B]: 'down' }) as never
    const pool = new RpcPool({ urls: [A, B] })

    // The important half: it throws. A zero here would be indistinguishable
    // from an emptied wallet.
    await expect(pool.balanceOf('0x0000000000000000000000000000000000000001')).rejects.toThrow(
      /no endpoint answered/
    )
  })

  it('names what it tried, so the failure is diagnosable', async () => {
    globalThis.fetch = fetchThat({ [A]: 'down', [B]: 'down' }) as never
    const pool = new RpcPool({ urls: [A, B] })

    await expect(pool.chainId()).rejects.toThrow(/a\.example.*b\.example/s)
  })

  it('needs at least one url to be a pool at all', () => {
    expect(() => new RpcPool({ urls: [] })).toThrow(RpcError)
  })
})

describe('benching a failed endpoint', () => {
  it('stops asking one that just failed', async () => {
    const fetcher = fetchThat({ [A]: 'down', [B]: 'ok' })
    globalThis.fetch = fetcher as never

    // Fixed, because this asserts the bench is respected rather than that it
    // expires. The test below is the one that moves the clock.
    const pool = new RpcPool({ urls: [A, B], now: () => 0 })

    await pool.chainId()
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Second call skips the benched one entirely.
    await pool.chainId()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('tries it again once the bench expires', async () => {
    const fetcher = fetchThat({ [A]: 'down', [B]: 'ok' })
    globalThis.fetch = fetcher as never

    let clock = 0
    const pool = new RpcPool({ urls: [A, B], now: () => clock })

    await pool.chainId()
    clock = 61_000
    await pool.chainId()

    // Four: two on the first call, then the recovered endpoint and the good one.
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('still tries something when everything is benched', async () => {
    // A pool that refused to ask because everything failed a minute ago is a
    // pool that stays broken after the network comes back.
    const answers: Record<string, 'ok' | 'down'> = { [A]: 'down', [B]: 'down' }
    globalThis.fetch = vi.fn(async (url: string) => {
      if (answers[String(url)] === 'down') throw new Error('connect ECONNREFUSED')
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }
    }) as never

    const pool = new RpcPool({ urls: [A, B], now: () => 0 })
    await expect(pool.chainId()).rejects.toThrow(/no endpoint answered/)

    answers[A] = 'ok'
    expect(await pool.chainId()).toBe(1)
  })
})

describe('a reply from the node is an answer', () => {
  it('a revert is not retried against another endpoint', async () => {
    // Asking a second node produces the same revert more slowly, and turns one
    // honest "insufficient funds" into several.
    const fetcher = fetchThat({ [A]: 'revert', [B]: 'ok' })
    globalThis.fetch = fetcher as never
    const pool = new RpcPool({ urls: [A, B] })

    await expect(pool.call({ to: A, data: '0x' })).rejects.toThrow(/reverted/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('nor is one that carries no decodable reason', async () => {
    // Most reverts are this shape — a custom error, or a bare `revert()`. An
    // earlier version keyed on the decoded reason instead of the error code and
    // sent every one of these round the whole endpoint list.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url) === A) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            error: { code: 3, message: 'execution reverted' }
          })
        }
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }
    }) as never

    const pool = new RpcPool({ urls: [A, B] })
    await expect(pool.call({ to: A, data: '0x' })).rejects.toThrow(/reverted/)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('but an HTTP failure is the endpoint, not the chain, so it moves on', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url) === A) return { ok: false, status: 429, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }
    }) as never

    const pool = new RpcPool({ urls: [A, B] })
    expect(await pool.chainId()).toBe(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('the chain registry', () => {
  it('puts Lightchain first, because that is what the wallet is for', () => {
    expect(CHAINS[0]?.id).toBe(9200)
  })

  it('gives every chain somewhere to fall back to', () => {
    for (const chain of CHAINS) {
      expect(chain.rpcUrls.length, chain.name).toBeGreaterThan(1)
    }
  })

  it('holds no duplicate ids or urls', () => {
    const ids = CHAINS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)

    const urls = CHAINS.flatMap((c) => c.rpcUrls)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('reaches every endpoint over https', () => {
    for (const chain of CHAINS) {
      for (const url of chain.rpcUrls) expect(url.startsWith('https://'), url).toBe(true)
    }
  })

  it('finds a chain by id, and admits when it does not know one', () => {
    expect(chainById(1)?.name).toBe('Ethereum')
    expect(chainById(9200)?.symbol).toBe('LCAI')
    expect(chainById(999_999)).toBe(null)
  })

  it('keeps the testnet out of the list somebody picks from', () => {
    // A test network beside five holding real money is one mis-click from
    // somebody sending to it.
    expect(CHAINS.some((c) => c.id === 8200)).toBe(false)
  })

  it('keeps the devnet out of the list somebody picks from, same as the testnet', () => {
    // Same posture as the testnet: reachable as a constant, never offered
    // alongside chains holding real money.
    expect(CHAINS.some((c) => c.id === 48221)).toBe(false)
    expect(chainById(48221)).toBeNull()
    expect(LIGHTCHAIN_DEVNET).toEqual({
      id: 48221,
      name: 'Lightchain devnet',
      symbol: 'LCAI',
      coinName: 'Lightchain AI',
      decimals: 18,
      rpcUrls: ['https://rpc.devnet-v2.lightchain.ai'],
      explorerUrl: 'https://devnet-v2.lightscan.app',
      multicall3: null
    })
  })

  it('gives every chain a symbol and eighteen decimals', () => {
    for (const chain of CHAINS) {
      expect(chain.symbol, chain.name).toMatch(/^[A-Z]{2,5}$/)
      expect(chain.decimals, chain.name).toBe(18)
    }
  })
})

describe('a client that fails over on reads and never on broadcast', () => {
  const PRIMARY = 'https://rpc.mainnet.lightchain.ai'
  const ARCHIVE = 'https://archive.mainnet.lightchain.ai'

  /**
   * What each endpoint was asked, as [url, method] pairs, so a test can say
   * not just how often a host was called but what it was asked to do.
   */
  function watchingFetch(answers: Record<string, 'ok' | 'down'>, result: unknown = '0x1') {
    const seen: [string, string][] = []
    const fetcher = vi.fn(async (url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body)
      seen.push([String(url), method])
      if (answers[String(url)] === 'down') throw new Error('connect ECONNREFUSED')
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
    })
    return { fetcher, seen }
  }

  it('answers a read from the archive when the primary is down', async () => {
    const { fetcher, seen } = watchingFetch({ [PRIMARY]: 'down', [ARCHIVE]: 'ok' })
    globalThis.fetch = fetcher as never

    const rpc = new FailoverRpc({ urls: [PRIMARY, ARCHIVE] })
    expect(await rpc.balanceOf('0x0000000000000000000000000000000000000001')).toBe(1n)
    // The primary was asked first and benched; the answer came from the archive.
    expect(seen).toEqual([
      [PRIMARY, 'eth_getBalance'],
      [ARCHIVE, 'eth_getBalance']
    ])
  })

  it('says when an endpoint is benched, because silence is how outages hide', async () => {
    const { fetcher } = watchingFetch({ [PRIMARY]: 'down', [ARCHIVE]: 'ok' })
    globalThis.fetch = fetcher as never

    const onBench = vi.fn()
    const rpc = new FailoverRpc({ urls: [PRIMARY, ARCHIVE], onBench })
    await rpc.chainId()

    expect(onBench).toHaveBeenCalledTimes(1)
    expect(onBench.mock.calls[0]?.[0]).toBe(PRIMARY)
    expect(onBench.mock.calls[0]?.[1]).toBeInstanceOf(Error)
  })

  it('sends a signed transaction to the primary alone, exactly once', async () => {
    const { fetcher, seen } = watchingFetch({ [PRIMARY]: 'ok', [ARCHIVE]: 'ok' }, '0xhash')
    globalThis.fetch = fetcher as never

    const rpc = new FailoverRpc({ urls: [PRIMARY, ARCHIVE] })
    expect(await rpc.sendRawTransaction('0xsigned')).toBe('0xhash')

    const broadcasts = seen.filter(([, method]) => method === 'eth_sendRawTransaction')
    expect(broadcasts).toEqual([[PRIMARY, 'eth_sendRawTransaction']])
  })

  it('a broadcast the primary could not hear is not repeated elsewhere', async () => {
    // A dropped connection cannot tell "never arrived" from "arrived and the
    // reply died", and guessing wrong spends twice — so nobody guesses.
    const { fetcher, seen } = watchingFetch({ [PRIMARY]: 'down', [ARCHIVE]: 'ok' })
    globalThis.fetch = fetcher as never

    const rpc = new FailoverRpc({ urls: [PRIMARY, ARCHIVE] })
    await expect(rpc.sendRawTransaction('0xsigned')).rejects.toThrow(RpcError)

    const broadcasts = seen.filter(([, method]) => method === 'eth_sendRawTransaction')
    expect(broadcasts).toEqual([[PRIMARY, 'eth_sendRawTransaction']])
  })

  it('a broadcast the node refused is handed back as the node said it', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'nonce too low' }
      })
    })) as never

    const rpc = new FailoverRpc({ urls: [PRIMARY, ARCHIVE] })
    const error = await rpc.sendRawTransaction('0xsigned').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RpcError)
    expect((error as RpcError).message).toMatch(/nonce too low/)
    expect((error as RpcError).code).toBe(-32000)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('a total outage reads exactly like the single-endpoint failure did', async () => {
    // Callers today catch an RpcError with no code; the pooled client must
    // raise the same shape, not a new kind of failure nobody handles.
    const { fetcher } = watchingFetch({ [PRIMARY]: 'down', [ARCHIVE]: 'down' })
    globalThis.fetch = fetcher as never

    const pooled = await new FailoverRpc({ urls: [PRIMARY, ARCHIVE] })
      .balanceOf('0x0000000000000000000000000000000000000001')
      .catch((err: unknown) => err)
    const lone = await new Rpc({ url: PRIMARY })
      .balanceOf('0x0000000000000000000000000000000000000001')
      .catch((err: unknown) => err)

    expect(pooled).toBeInstanceOf(RpcError)
    expect((pooled as RpcError).code).toBe((lone as RpcError).code)
    expect((pooled as RpcError).code).toBeNull()
    expect((pooled as RpcError).message).toMatch(/no endpoint answered/)
  })

  it('rebuilds per network: mainnet fails over, testnet stands alone', async () => {
    // The worker derives each network's endpoints the same way it switches
    // profiles: the profile's own url first, then whatever the registry adds.
    // The testnet is deliberately not in `chainById` — it is kept out of the
    // list holding real money — so its profile's single url is all there is.
    const mainnet = chainById(9200)
    expect(mainnet?.rpcUrls).toEqual([PRIMARY, ARCHIVE])
    expect(chainById(8200)).toBeNull()
    expect(LIGHTCHAIN_TESTNET.rpcUrls).toEqual(['https://rpc.testnet.lightchain.ai'])

    const { fetcher, seen } = watchingFetch({ [PRIMARY]: 'down', [ARCHIVE]: 'ok' })
    globalThis.fetch = fetcher as never

    const onMainnet = new FailoverRpc({ urls: [...(mainnet?.rpcUrls ?? [])] })
    expect(await onMainnet.chainId()).toBe(1)
    expect(seen.map(([url]) => url)).toEqual([PRIMARY, ARCHIVE])

    // A second build carries none of the first's benching or endpoints.
    const onTestnet = new FailoverRpc({ urls: [...LIGHTCHAIN_TESTNET.rpcUrls] })
    expect(onTestnet.urls).toEqual(['https://rpc.testnet.lightchain.ai'])
    expect(onMainnet.urls).toEqual([PRIMARY, ARCHIVE])
  })
})
