import { Rpc, RpcError, type RpcOptions } from './rpc.js'

/**
 * Several endpoints for one chain, tried until one answers.
 *
 * Public RPC endpoints fail often enough that treating one as the chain is a
 * mistake: a survey of eighteen well-known ones found six failing on a single
 * afternoon. The failure that matters is not the error — it is what an
 * application does with it, because a balance read that throws and gets caught
 * somewhere upstream renders as **zero**, and a user looking at a zero balance
 * has no way to tell an outage from a theft.
 *
 * So this never reports a number it did not get. Either an endpoint answered,
 * or every endpoint failed and the caller is told exactly that.
 *
 * ## What counts as a failure worth moving on from
 *
 * Only transport failures and endpoint policy. A JSON-RPC error is an answer:
 * the node received the question and told us what it thinks, and asking a
 * second node produces the same reply more slowly. Retrying those would turn
 * one honest "insufficient funds" into three, and would broadcast a transaction
 * repeatedly if it ever wrapped a send — so `sendRawTransaction` is
 * deliberately not routed through the retry at all.
 *
 * The signal is the JSON-RPC error code, not the decoded revert reason. A
 * revert with no reason data — which is most of them, since custom errors and
 * bare `revert()` carry nothing decodable — has a code and no reason, and
 * keying on the reason would send those round every endpoint in the list.
 */

/** How long an endpoint stays benched after it fails. */
const BENCH_MS = 60_000

interface Endpoint {
  readonly url: string
  readonly rpc: Rpc
  /** When it may be tried again. Zero means now. */
  benchedUntil: number
}

export interface PoolOptions extends Omit<RpcOptions, 'url'> {
  readonly urls: readonly string[]
  /** Injectable so the bench can be tested without waiting a minute. */
  readonly now?: () => number
}

export class RpcPool {
  readonly #endpoints: Endpoint[]
  readonly #now: () => number

  constructor(options: PoolOptions) {
    if (options.urls.length === 0) throw new RpcError('a pool needs at least one url')

    this.#now = options.now ?? Date.now
    this.#endpoints = options.urls.map((url) => ({
      url,
      rpc: new Rpc({ ...options, url }),
      benchedUntil: 0
    }))
  }

  /** Which endpoint answered last, for a screen that says where its numbers came from. */
  get current(): string {
    return this.#preferred()[0]?.url ?? ''
  }

  get urls(): readonly string[] {
    return this.#endpoints.map((e) => e.url)
  }

  /**
   * Healthy endpoints first, then benched ones in their original order.
   *
   * Benched endpoints are kept rather than skipped. When every endpoint has
   * failed recently the right move is still to try one — a wallet that refuses
   * to ask because everything failed a minute ago is a wallet that stays broken
   * after the network comes back.
   */
  #preferred(): Endpoint[] {
    const now = this.#now()
    const ready = this.#endpoints.filter((e) => e.benchedUntil <= now)
    const benched = this.#endpoints.filter((e) => e.benchedUntil > now)
    return [...ready, ...benched]
  }

  /**
   * Runs something against each endpoint until one works.
   *
   * The callback takes an `Rpc` rather than this taking a method name, so that
   * a caller needing several calls against *the same* endpoint can have that,
   * and a caller needing one can ignore it.
   */
  async use<T>(work: (rpc: Rpc) => Promise<T>): Promise<T> {
    const tried: string[] = []
    let last: unknown = null

    for (const endpoint of this.#preferred()) {
      try {
        const answer = await work(endpoint.rpc)
        endpoint.benchedUntil = 0
        return answer
      } catch (err) {
        // A code means the node answered. Moving on would ask another one the
        // same question and get the same reply, slower.
        if (err instanceof RpcError && err.code !== null) throw err

        endpoint.benchedUntil = this.#now() + BENCH_MS
        tried.push(endpoint.url)
        last = err
      }
    }

    const why = last instanceof Error ? last.message : String(last)
    throw new RpcError(
      `no endpoint answered for this chain (tried ${tried.join(', ')}). The last said: ${why}`
    )
  }

  send<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    return this.use((rpc) => rpc.send<T>(method, params))
  }

  call(request: Parameters<Rpc['call']>[0]): Promise<string> {
    return this.use((rpc) => rpc.call(request))
  }

  chainId(): Promise<number> {
    return this.use((rpc) => rpc.chainId())
  }

  blockNumber(): Promise<bigint> {
    return this.use((rpc) => rpc.blockNumber())
  }

  balanceOf(address: string): Promise<bigint> {
    return this.use((rpc) => rpc.balanceOf(address))
  }
}
