import fetch from '#fetch'
import { decodeRevert } from './abi.js'
import { fromQuantity, toQuantity } from './hex.js'

/**
 * JSON-RPC over HTTP.
 *
 * `#fetch` resolves to `bare-fetch` under Bare and the global elsewhere. Bare
 * has no global fetch at all, so reaching for one directly works in tests and
 * fails in the worker — which is where this actually runs.
 */

export class RpcError extends Error {
  readonly code: number | null
  /** The decoded revert reason, when the node returned one. */
  readonly reason: string | null

  constructor(message: string, code: number | null = null, reason: string | null = null) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.reason = reason
  }
}

export interface RpcOptions {
  readonly url: string
  /** Milliseconds. A node that never answers should not hang the worker. */
  readonly timeout?: number
}

export interface CallRequest {
  readonly to: string
  readonly data: string
  readonly from?: string
}

export class Rpc {
  readonly #url: string
  readonly #timeout: number
  #id = 0

  constructor(opts: RpcOptions) {
    if (!/^https?:\/\//.test(opts.url)) {
      throw new RpcError(`rpc url must be http or https, got ${JSON.stringify(opts.url)}`)
    }
    this.#url = opts.url
    this.#timeout = opts.timeout ?? 15_000
  }

  async send<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const id = ++this.#id

    let response
    try {
      // Raced rather than aborted: Bare has no AbortController.
      let timer: ReturnType<typeof setTimeout> | undefined
      response = await Promise.race([
        fetch(this.#url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.#timeout)
          timer.unref?.()
        })
      ])
      clearTimeout(timer)
    } catch (err) {
      throw new RpcError(`${method}: could not reach ${this.#url} — ${(err as Error).message}`)
    }

    if (!response)
      throw new RpcError(`${method}: ${this.#url} did not answer in ${this.#timeout}ms`)
    if (!response.ok) throw new RpcError(`${method}: ${this.#url} returned HTTP ${response.status}`)

    let body: { result?: T; error?: { code?: number; message?: string; data?: string } }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new RpcError(`${method}: ${this.#url} returned something that is not JSON`)
    }

    if (body.error) {
      // A revert carries its reason in `data`, and surfacing "execution
      // reverted" without it wastes everyone's afternoon.
      const reason = body.error.data ? decodeRevert(body.error.data) : null
      const detail = reason ? `${body.error.message}: ${reason}` : (body.error.message ?? 'failed')
      throw new RpcError(`${method}: ${detail}`, body.error.code ?? null, reason)
    }

    if (body.result === undefined) throw new RpcError(`${method}: response had no result`)
    return body.result
  }

  /** `eth_call` against the latest block. */
  async call(request: CallRequest): Promise<string> {
    return this.send<string>('eth_call', [{ ...request }, 'latest'])
  }

  async chainId(): Promise<number> {
    return Number(fromQuantity(await this.send<string>('eth_chainId')))
  }

  async blockNumber(): Promise<bigint> {
    return fromQuantity(await this.send<string>('eth_blockNumber'))
  }

  async balanceOf(address: string): Promise<bigint> {
    return fromQuantity(await this.send<string>('eth_getBalance', [address, 'latest']))
  }

  async transactionCount(address: string): Promise<bigint> {
    return fromQuantity(await this.send<string>('eth_getTransactionCount', [address, 'pending']))
  }

  async estimateGas(request: CallRequest & { from: string; value?: bigint }): Promise<bigint> {
    const { value, ...rest } = request
    const params = value === undefined ? rest : { ...rest, value: toQuantity(value) }
    return fromQuantity(await this.send<string>('eth_estimateGas', [params]))
  }

  async sendRawTransaction(signed: string): Promise<string> {
    return this.send<string>('eth_sendRawTransaction', [signed])
  }
}
