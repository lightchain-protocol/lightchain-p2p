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
  /**
   * Called each time an endpoint is benched, with which one and why.
   *
   * Optional, but a bench nobody hears about is an outage that looks like slow
   * answers. Whoever owns the process should log this rather than discover the
   * failure later from a graph that went flat.
   */
  readonly onBench?: (url: string, err: unknown) => void
}

export class RpcPool {
  readonly #endpoints: Endpoint[]
  readonly #now: () => number
  readonly #onBench: ((url: string, err: unknown) => void) | undefined

  constructor(options: PoolOptions) {
    if (options.urls.length === 0) throw new RpcError('a pool needs at least one url')

    this.#now = options.now ?? Date.now
    this.#onBench = options.onBench
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
   * Who to ask, and how many of them.
   *
   * While any endpoint is healthy, only healthy ones are tried. When every one
   * of them is benched, exactly one is tried — the one benched longest ago —
   * rather than all of them.
   *
   * That last part is the difference between an outage being slow and an outage
   * being unusable. Previously a benched endpoint was reordered but never
   * skipped, so with the chain down every call walked the whole list and waited
   * for each to time out in turn. Six networks, several reads apiece, and the
   * application spent its time queueing behind connections it already knew were
   * refusing — which is what "laggy" was.
   *
   * Trying one keeps the recovery the old comment was right to insist on: a
   * wallet that refuses to ask because everything failed a minute ago is a
   * wallet that stays broken after the network comes back. One probe finds that
   * out at one timeout instead of five.
   */
  #preferred(): Endpoint[] {
    const now = this.#now()
    const ready = this.#endpoints.filter((e) => e.benchedUntil <= now)
    if (ready.length > 0) return ready

    let oldest: Endpoint | null = null
    for (const endpoint of this.#endpoints) {
      if (oldest === null || endpoint.benchedUntil < oldest.benchedUntil) oldest = endpoint
    }
    return oldest === null ? [] : [oldest]
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

        /*
         * Said once per bench, not once per failure.
         *
         * An endpoint that is already benched and fails again is not news —
         * it is the same outage being rediscovered. Logging every one filled
         * the diagnostics file with one repeated line and drowned the events
         * worth finding in it.
         */
        const now = this.#now()
        const already = endpoint.benchedUntil > now
        endpoint.benchedUntil = now + BENCH_MS
        tried.push(endpoint.url)
        last = err
        if (!already) this.#onBench?.(endpoint.url, err)
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

/**
 * A whole chain client whose reads survive an endpoint dying.
 *
 * `RpcPool` answers one call at a time and stops there; this is the rest of
 * the surface — `fees`, `estimateGas`, receipts, everything `Rpc` offers —
 * with every method routed the same way, because they all bottom out in
 * `send`. Anything but a broadcast fails over: the first endpoint is asked
 * first, a transport failure benches it, and the next one answers. A node
 * that answered is never second-guessed — the pool's own rule, kept here.
 *
 * ## Why broadcast is the exception
 *
 * `eth_sendRawTransaction` goes to the first endpoint, once, and nowhere
 * else. A read asked twice is the same question twice; a broadcast repeated
 * is not. When the connection drops after the bytes left there is no telling
 * "the node never got it" from "it got it and the reply died on the way
 * back", and a nonce read from one node paired with a broadcast to another
 * is how two transactions leave against the same funds. The pool above keeps
 * `sendRawTransaction` out of its retry for this reason; this class keeps the
 * same split by pinning the one broadcast method to the primary.
 *
 * What a failed broadcast raises is exactly what the single-endpoint client
 * raised — an `RpcError` from the primary — so every caller that handles that
 * failure today handles this one unchanged.
 */
export class FailoverRpc extends Rpc {
  readonly #pool: RpcPool

  constructor(options: PoolOptions) {
    const primary = options.urls[0]
    if (primary === undefined) throw new RpcError('a pool needs at least one url')
    super({ ...options, url: primary })
    this.#pool = new RpcPool(options)
  }

  /** Every endpoint this reads through, primary first. */
  get urls(): readonly string[] {
    return this.#pool.urls
  }

  /**
   * Reads fail over; broadcast does not.
   *
   * This is the single choke point every other method in `Rpc` flows through,
   * so overriding it here splits the whole surface without re-listing it.
   */
  override send<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (method === 'eth_sendRawTransaction') return super.send(method, params)
    return this.#pool.use((rpc) => rpc.send<T>(method, params))
  }
}
