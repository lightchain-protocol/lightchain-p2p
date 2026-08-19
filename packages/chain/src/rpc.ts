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
  /**
   * Custom error selectors to signatures, so reverts read as something other
   * than four bytes of hex. Injected rather than built in, because which
   * contracts are being talked to is not this layer's business — pass
   * `lightchainErrors()`.
   */
  readonly errors?: ReadonlyMap<string, string>
}

export interface CallRequest {
  readonly to: string
  readonly data: string
  readonly from?: string
}

export interface FeeEstimate {
  /** Burned, and set by the protocol rather than chosen. */
  readonly baseFeePerGas: bigint
  /** Kept by the proposer. */
  readonly maxPriorityFeePerGas: bigint
  /** A ceiling, not a price. The difference is refunded. */
  readonly maxFeePerGas: bigint
}

export interface Log {
  readonly address: string
  /** `[eventSignatureHash, ...indexedArguments]`. */
  readonly topics: readonly string[]
  readonly data: string
}

export interface Receipt {
  readonly transactionHash: string
  readonly blockNumber: bigint
  readonly gasUsed: bigint
  readonly effectiveGasPrice: bigint
  /** False when the transaction reverted. It was still mined, and still paid. */
  readonly status: boolean
  readonly contractAddress: string | null
  /**
   * What the contract emitted. Often the only place a value the contract
   * assigned — an id it minted, say — is reported back to the caller.
   */
  readonly logs: readonly Log[]
}

export interface WaitOptions {
  readonly timeout?: number
  readonly interval?: number
  /**
   * How deep to wait before returning.
   *
   * One is the default and returns at the first receipt: the including block
   * counts as the first confirmation, which is what explorers and every other
   * client mean by the word. Six waits until five further blocks sit on top.
   *
   * Depth is not finality. A block that has already been built on can still be
   * reorganised away, taking the receipt with it, and each further confirmation
   * only makes that less likely rather than impossible. How much depth is worth
   * having depends on the chain's consensus, so the number belongs to the
   * caller rather than to a default chosen here.
   */
  readonly confirmations?: number
}

/**
 * A transaction as a node holds it, whether mined or still in the mempool.
 *
 * Not the `Transaction` in `account.ts`, which is the thing that gets signed.
 * The two overlap and are not the same shape: this one has been broadcast, so
 * it has a hash, a recovered sender, and either a block or nothing.
 */
export interface TransactionDetails {
  readonly hash: string
  /**
   * Recovered from the signature by the node, and lowercase as it reports it.
   * The same is true of `to`. Compare case-insensitively, or run either through
   * `toChecksumAddress` before showing it to anyone.
   */
  readonly from: string
  /** Null for a contract creation, which is the only transaction with no recipient. */
  readonly to: string | null
  readonly nonce: bigint
  readonly value: bigint
  /** Call data. Named as the JSON-RPC field is, which is `input` and not `data`. */
  readonly input: string
  /** The limit that was signed, not what was used. The receipt has that. */
  readonly gas: bigint
  /** Null on a legacy transaction, which has a `gasPrice` and neither of these. */
  readonly maxFeePerGas: bigint | null
  readonly maxPriorityFeePerGas: bigint | null
  /**
   * What the sender is actually paying. Nodes report the fee cap here while a
   * type 2 transaction is pending and the effective price once it is mined, so
   * it is worth reading only alongside `blockNumber`.
   */
  readonly gasPrice: bigint | null
  /** Null while pending. */
  readonly blockNumber: bigint | null
  readonly blockHash: string | null
  /** 2 for EIP-1559, which is all this package signs. */
  readonly type: number
}

interface RawReceipt {
  readonly transactionHash: string
  readonly blockNumber: string
  readonly gasUsed: string
  readonly effectiveGasPrice?: string
  readonly status: string
  readonly contractAddress?: string | null
  readonly logs?: readonly Log[]
}

interface RawTransaction {
  readonly hash: string
  readonly from: string
  readonly to?: string | null
  readonly nonce: string
  readonly value: string
  readonly input?: string
  readonly gas: string
  readonly gasPrice?: string | null
  readonly maxFeePerGas?: string | null
  readonly maxPriorityFeePerGas?: string | null
  readonly blockNumber?: string | null
  readonly blockHash?: string | null
  readonly type?: string
}

export class Rpc {
  readonly #url: string
  readonly #timeout: number
  readonly #errors: ReadonlyMap<string, string> | undefined
  #id = 0

  constructor(opts: RpcOptions) {
    if (!/^https?:\/\//.test(opts.url)) {
      throw new RpcError(`rpc url must be http or https, got ${JSON.stringify(opts.url)}`)
    }
    this.#url = opts.url
    this.#timeout = opts.timeout ?? 15_000
    this.#errors = opts.errors
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
      const reason = body.error.data ? decodeRevert(body.error.data, this.#errors) : null
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

  /**
   * What to pay, under EIP-1559.
   *
   * The base fee is burned and set by the protocol; the priority fee is what a
   * proposer keeps. `maxFeePerGas` is a ceiling rather than a price — anything
   * above `baseFee + priority` is refunded — so the headroom below is not a cost
   * so much as insurance against the base fee rising before inclusion.
   */
  async fees(): Promise<FeeEstimate> {
    const block = await this.send<{ baseFeePerGas?: string }>('eth_getBlockByNumber', [
      'latest',
      false
    ])
    const baseFeePerGas = block?.baseFeePerGas ? fromQuantity(block.baseFeePerGas) : 0n

    let maxPriorityFeePerGas: bigint
    try {
      maxPriorityFeePerGas = fromQuantity(await this.send<string>('eth_maxPriorityFeePerGas'))
    } catch {
      // Not every node implements it. `eth_gasPrice` already includes the base
      // fee, so the tip is what is left after taking that away.
      const gasPrice = fromQuantity(await this.send<string>('eth_gasPrice'))
      maxPriorityFeePerGas = gasPrice > baseFeePerGas ? gasPrice - baseFeePerGas : 0n
    }

    // A quiet chain reports zero, because no block has had to compete. One wei
    // costs nothing and avoids depending on proposers accepting no tip at all.
    if (maxPriorityFeePerGas === 0n) maxPriorityFeePerGas = 1n

    return {
      baseFeePerGas,
      maxPriorityFeePerGas,
      // Doubling covers roughly six consecutive full blocks, the usual headroom.
      maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas
    }
  }

  /** Null until mined. A transaction the node has never seen is also null. */
  async transactionReceipt(hash: string): Promise<Receipt | null> {
    const raw = await this.send<RawReceipt | null>('eth_getTransactionReceipt', [hash])
    if (!raw) return null

    return {
      transactionHash: raw.transactionHash,
      blockNumber: fromQuantity(raw.blockNumber),
      gasUsed: fromQuantity(raw.gasUsed),
      effectiveGasPrice: raw.effectiveGasPrice ? fromQuantity(raw.effectiveGasPrice) : 0n,
      // "Mined" and "did what you asked" are different. A reverted transaction
      // still gets a receipt, and still costs the gas it burned.
      status: fromQuantity(raw.status) === 1n,
      contractAddress: raw.contractAddress ?? null,
      logs: raw.logs ?? []
    }
  }

  /**
   * A transaction as the node has it, mined or pending. Null when it has never
   * seen the hash.
   *
   * Worth having alongside the receipt because a receipt exists only once a
   * transaction is mined, which leaves three quite different situations looking
   * identical: still queued, dropped from the mempool, and never broadcast at
   * all. This tells them apart — null for a hash the node does not know, a null
   * `blockNumber` for one it is holding, a number for one it has mined — and
   * that is the difference between a wallet that can say what is happening and
   * one that can only show a spinner.
   */
  async transactionByHash(hash: string): Promise<TransactionDetails | null> {
    const raw = await this.send<RawTransaction | null>('eth_getTransactionByHash', [hash])
    if (!raw) return null

    return {
      hash: raw.hash,
      from: raw.from,
      to: raw.to ?? null,
      nonce: fromQuantity(raw.nonce),
      value: fromQuantity(raw.value),
      input: raw.input ?? '0x',
      gas: fromQuantity(raw.gas),
      gasPrice: raw.gasPrice ? fromQuantity(raw.gasPrice) : null,
      maxFeePerGas: raw.maxFeePerGas ? fromQuantity(raw.maxFeePerGas) : null,
      maxPriorityFeePerGas: raw.maxPriorityFeePerGas
        ? fromQuantity(raw.maxPriorityFeePerGas)
        : null,
      blockNumber: raw.blockNumber ? fromQuantity(raw.blockNumber) : null,
      blockHash: raw.blockHash ?? null,
      type: raw.type ? Number(fromQuantity(raw.type)) : 0
    }
  }

  /**
   * Waits for inclusion, and optionally for depth on top of it.
   *
   * Timing out does not mean the transaction failed — it may still be pending,
   * and it may still be mined afterwards. The distinction matters because
   * resending on a timeout is how people spend twice.
   */
  async waitForReceipt(
    hash: string,
    { timeout = 120_000, interval = 1_500, confirmations = 1 }: WaitOptions = {}
  ): Promise<Receipt> {
    if (!Number.isInteger(confirmations) || confirmations < 1) {
      throw new RpcError(
        `confirmations must be a whole number of at least 1, got ${confirmations}. Inclusion is one confirmation; there is nothing shallower to wait for.`
      )
    }

    const deadline = Date.now() + timeout
    const depth = BigInt(confirmations)

    for (;;) {
      // Read afresh every round rather than keeping the first answer. A reorg
      // can move a transaction into a different block or drop it back into the
      // mempool, and depth counted from a block that no longer contains it is
      // worse than no count at all — it is a confident wrong answer.
      const receipt = await this.transactionReceipt(hash)

      if (receipt && confirmations === 1) return receipt
      if (receipt) {
        // The including block is itself the first confirmation, so a head at
        // the same height is already one deep.
        const head = await this.blockNumber()
        if (head - receipt.blockNumber + 1n >= depth) return receipt
      }

      if (Date.now() >= deadline) {
        const seconds = Math.round(timeout / 1000)
        throw new RpcError(
          receipt
            ? `${hash} was mined in block ${receipt.blockNumber} but had not reached ${confirmations} confirmations within ${seconds}s. It is included and the nonce is spent, so resending would be a second transaction rather than a retry.`
            : `${hash} was not mined within ${seconds}s. It may still be pending; do not resend it without checking the nonce.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }
}
