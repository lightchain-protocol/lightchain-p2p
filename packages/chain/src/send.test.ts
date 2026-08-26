import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseTransaction, recoverTransactionAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  FEE_PER_GAS_CEILING,
  Rpc,
  RpcError,
  SETTLE_CONFIRMATIONS,
  cancel,
  fromPrivateKey,
  sendTransaction,
  speedUp,
  upfrontCost,
  type SentTransaction
} from './index.js'

/**
 * A real HTTP server standing in for a node, so the paths that only appear
 * against one — a pending receipt, a reverted transaction, a node that has
 * never heard of a hash — are reachable rather than argued about.
 *
 * viem reads back what was broadcast wherever a claim is about bytes. "The
 * replacement kept the nonce" is a claim about bytes, and an assertion against
 * the object this package returned would only prove it agrees with itself.
 */

// Anvil's first key. Public, holds nothing.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = fromPrivateKey(KEY)
const theirs = privateKeyToAccount(KEY)
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

let server: Server
let url: string
let handler: (method: string, params: readonly unknown[]) => unknown
let seen: { method: string; params: readonly unknown[] }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number
        method: string
        params?: unknown[]
      }
      seen.push({ method, params: params ?? [] })
      let result: unknown
      try {
        result = handler(method, params ?? [])
      } catch (err) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: (err as Error).message }
          })
        )
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** The quiet-chain numbers this testnet actually reports. */
const happyNode = (over: Record<string, unknown> = {}) => {
  const table: Record<string, unknown> = {
    eth_chainId: '0x2008',
    eth_getTransactionCount: '0x7',
    eth_getBlockByNumber: { baseFeePerGas: '0x7' },
    eth_maxPriorityFeePerGas: '0x1',
    eth_estimateGas: '0x5208',
    eth_sendRawTransaction: '0xabc',
    eth_getTransactionReceipt: {
      transactionHash: '0xabc',
      blockNumber: '0x10',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x8',
      status: '0x1'
    },
    ...over
  }
  return (method: string) => {
    if (!(method in table)) throw new Error(`unexpected method ${method}`)
    const value = table[method]
    if (typeof value === 'function') return (value as () => unknown)()
    return value
  }
}

const methods = () => seen.map((call) => call.method)

const broadcasts = () =>
  seen
    .filter((call) => call.method === 'eth_sendRawTransaction')
    .map((call) => call.params[0] as `0x02${string}`)

/** The last thing put on the wire, which is what any claim about bytes is about. */
const latest = () => broadcasts()[broadcasts().length - 1] as `0x02${string}`

describe('the chain a transaction is signed for', () => {
  // The chain id is what stops a signed transaction being replayed on another
  // chain, so taking it from the node means taking it from the one party with
  // something to gain by lying. A proxy answering `eth_chainId` with 1 gets a
  // transaction signed for Ethereum mainnet, by the real key, replayable there
  // for as long as the nonce is free. The same thing happens by accident with
  // an RPC URL pointing at the wrong network, which is far more common.

  it('refuses when the node claims a different chain, and signs nothing', async () => {
    handler = happyNode({ eth_chainId: '0x1' })
    seen = []

    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, value: 1n, chainId: 9200n })
    ).rejects.toThrow(/says it is chain 1.*for chain 9200/s)

    // Nothing was put on the wire. A refusal after broadcasting would be no
    // refusal at all.
    expect(broadcasts()).toHaveLength(0)
  })

  it('proceeds when the node agrees', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, {
      to: TO,
      value: 1n,
      chainId: 8200n
    })

    expect(parseTransaction(latest()).chainId).toBe(8200)
    expect(sent.hash).toBe('0xabc')
  })

  it('carries the expectation into a replacement', async () => {
    // A speed-up signs a second transaction, so it needs the same guard. It is
    // also the moment somebody is least likely to be looking.
    handler = happyNode({ eth_chainId: '0x1', eth_getTransactionReceipt: null })
    seen = []

    const held = {
      hash: '0xabc',
      nonce: 7n,
      gas: 26_250n,
      to: TO,
      value: 1000n,
      data: '0x',
      maxFeePerGas: 15n,
      maxPriorityFeePerGas: 1n,
      wait: () => Promise.reject(new Error('not used'))
    }

    await expect(speedUp(new Rpc({ url }), account, held, undefined, 9200n)).rejects.toThrow(
      /says it is chain 1/
    )
    expect(broadcasts()).toHaveLength(0)
  })

  it('still signs against the node when no expectation is given', async () => {
    // The old behaviour, kept because it cannot be removed without breaking
    // every caller at once. It is why the field exists rather than a default.
    handler = happyNode({ eth_chainId: '0x1' })
    seen = []

    await sendTransaction(new Rpc({ url }), account, { to: TO })
    expect(parseTransaction(latest()).chainId).toBe(1)
  })
})

describe('sending', () => {
  it('assembles a transaction from what the node reports', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO, value: 1000n })

    expect(sent.hash).toBe('0xabc')
    expect(sent.nonce).toBe(7n)
    // 21000 estimated, plus the margin that covers state moving between
    // estimation and execution.
    expect(sent.gas).toBe(26250n)
    expect(sent.maxPriorityFeePerGas).toBe(1n)
    // Base doubled, plus the tip.
    expect(sent.maxFeePerGas).toBe(15n)
  })

  it('reads the nonce as pending, so two sends in a row do not collide', async () => {
    handler = happyNode()
    seen = []
    await sendTransaction(new Rpc({ url }), account, { to: TO })

    const nonce = seen.find((call) => call.method === 'eth_getTransactionCount')
    expect(nonce?.params[1]).toBe('pending')
  })

  it('broadcasts a signed transaction and nothing else', async () => {
    handler = happyNode()
    seen = []
    await sendTransaction(new Rpc({ url }), account, { to: TO, value: 1000n })

    const raw = seen.find((call) => call.method === 'eth_sendRawTransaction')
    const signed = raw?.params[0] as string
    // Type 2, EIP-1559, and not a private key or anything else by accident.
    expect(signed.startsWith('0x02')).toBe(true)
    expect(signed).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478')
  })

  it('skips estimation when a gas limit is given', async () => {
    handler = happyNode({
      eth_estimateGas: () => {
        throw new Error('should not be called')
      }
    })
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO, gas: 90_000n })
    expect(sent.gas).toBe(90_000n)
  })

  it('falls back to gasPrice when the node has no maxPriorityFeePerGas', async () => {
    handler = happyNode({
      eth_maxPriorityFeePerGas: () => {
        throw new Error('the method eth_maxPriorityFeePerGas does not exist')
      },
      eth_gasPrice: '0x8'
    })

    // gasPrice includes the base fee, so the tip is what remains of it.
    const fees = await new Rpc({ url }).fees()
    expect(fees.maxPriorityFeePerGas).toBe(1n)
    expect(fees.maxFeePerGas).toBe(15n)
  })

  it('never asks for a zero tip, even on a chain that reports one', async () => {
    handler = happyNode({ eth_maxPriorityFeePerGas: '0x0' })
    const fees = await new Rpc({ url }).fees()
    expect(fees.maxPriorityFeePerGas).toBe(1n)
  })

  it('copes with a chain that has no base fee at all', async () => {
    handler = happyNode({ eth_getBlockByNumber: {} })
    const fees = await new Rpc({ url }).fees()
    expect(fees.baseFeePerGas).toBe(0n)
    expect(fees.maxFeePerGas).toBe(1n)
  })

  it('refuses an address that is not one, before spending a round trip', async () => {
    handler = happyNode()
    seen = []
    await expect(sendTransaction(new Rpc({ url }), account, { to: '0x1234' })).rejects.toThrow(
      /not a 20-byte address/
    )
    expect(seen).toHaveLength(0)
  })

  it('surfaces what the node said when it refuses the transaction', async () => {
    handler = happyNode({
      eth_sendRawTransaction: () => {
        throw new Error('insufficient funds for gas * price + value')
      }
    })
    await expect(sendTransaction(new Rpc({ url }), account, { to: TO })).rejects.toThrow(
      /insufficient funds/
    )
  })
})

describe('fees a caller chooses', () => {
  it('signs what it was given rather than what the market said', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, {
      to: TO,
      value: 1000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n
    })

    expect(sent.maxFeePerGas).toBe(3_000_000_000n)
    expect(sent.maxPriorityFeePerGas).toBe(1_500_000_000n)

    // And the bytes say so too, against viem signing the same fields. The
    // returned object agreeing with itself would prove nothing.
    expect(latest()).toBe(
      await theirs.signTransaction({
        chainId: 8200,
        nonce: 7,
        to: TO,
        value: 1000n,
        data: '0x',
        gas: 26_250n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 1_500_000_000n,
        type: 'eip1559'
      })
    )
  })

  it('does not ask what gas costs when it has been told', async () => {
    handler = happyNode()
    seen = []

    await sendTransaction(new Rpc({ url }), account, {
      to: TO,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 2n
    })

    expect(methods()).not.toContain('eth_getBlockByNumber')
    expect(methods()).not.toContain('eth_maxPriorityFeePerGas')
  })

  it('takes the market tip when only the ceiling is given', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO, maxFeePerGas: 500n })
    expect(sent.maxFeePerGas).toBe(500n)
    expect(sent.maxPriorityFeePerGas).toBe(1n)
  })

  it('takes the market ceiling when only the tip is given', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, {
      to: TO,
      maxPriorityFeePerGas: 4n
    })
    expect(sent.maxFeePerGas).toBe(15n)
    expect(sent.maxPriorityFeePerGas).toBe(4n)
  })

  it('signs the nonce it was given, without asking for one', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO, nonce: 3n })

    expect(sent.nonce).toBe(3n)
    expect(methods()).not.toContain('eth_getTransactionCount')
    expect(parseTransaction(latest()).nonce).toBe(3)
  })

  it('refuses a tip above the ceiling it is paid out of', async () => {
    handler = happyNode()
    seen = []

    await expect(
      sendTransaction(new Rpc({ url }), account, {
        to: TO,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 11n
      })
    ).rejects.toThrow(/above maxFeePerGas/)

    // Not after a round trip, and certainly not after signing one.
    expect(seen).toHaveLength(0)
  })

  it('refuses a ceiling that cannot cover the tip the market wants', async () => {
    // The caller set only one of the two, so the pair it ends up with is half
    // theirs and half the node's — and still has to make sense.
    handler = happyNode()
    seen = []

    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, maxFeePerGas: 0n })
    ).rejects.toThrow(/above maxFeePerGas/)
    expect(broadcasts()).toHaveLength(0)
  })

  it('refuses a fee nobody could have meant', async () => {
    handler = happyNode()
    seen = []

    // One whole token per unit of gas: a 21,000-gas transfer for 21,000 tokens.
    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, maxFeePerGas: 10n ** 18n })
    ).rejects.toThrow(/above the ceiling/)

    // The way it actually happens: two gwei, typed as though the field took a
    // whole-token amount.
    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, maxFeePerGas: 2n * 10n ** 18n })
    ).rejects.toThrow(/meant as gwei/)

    // And the tip is held to the same bound as the ceiling.
    await expect(
      sendTransaction(new Rpc({ url }), account, {
        to: TO,
        maxFeePerGas: FEE_PER_GAS_CEILING,
        maxPriorityFeePerGas: FEE_PER_GAS_CEILING + 1n
      })
    ).rejects.toThrow(/above the ceiling/)

    expect(seen).toHaveLength(0)
  })

  it('allows the ceiling itself, and refuses one wei more', async () => {
    handler = happyNode()
    seen = []

    const sent = await sendTransaction(new Rpc({ url }), account, {
      to: TO,
      maxFeePerGas: FEE_PER_GAS_CEILING,
      maxPriorityFeePerGas: 1n
    })
    expect(sent.maxFeePerGas).toBe(FEE_PER_GAS_CEILING)

    await expect(
      sendTransaction(new Rpc({ url }), account, {
        to: TO,
        maxFeePerGas: FEE_PER_GAS_CEILING + 1n
      })
    ).rejects.toThrow(/above the ceiling/)
  })

  it('refuses a negative fee or a negative nonce', async () => {
    handler = happyNode()
    seen = []

    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, maxFeePerGas: -1n })
    ).rejects.toThrow(/cannot be negative/)
    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, maxPriorityFeePerGas: -1n })
    ).rejects.toThrow(/cannot be negative/)
    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, nonce: -1n })
    ).rejects.toThrow(/nonce must fit in a uint64/)
    // Nonces are a uint64 on the wire; nothing will hold one above that.
    await expect(
      sendTransaction(new Rpc({ url }), account, { to: TO, nonce: 2n ** 64n })
    ).rejects.toThrow(/nonce must fit in a uint64/)

    expect(seen).toHaveLength(0)

    // And the largest one that does fit is signed without complaint.
    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO, nonce: 2n ** 64n - 1n })
    expect(sent.nonce).toBe(2n ** 64n - 1n)
  })

  it('holds the node to the same ceiling as the caller', async () => {
    // A proxy answering for a different chain, or a devnet configured by hand,
    // reports a base fee that empties an account just as thoroughly as a typo
    // does — and nobody typed it, so nobody is looking for it.
    handler = happyNode({ eth_getBlockByNumber: { baseFeePerGas: '0xde0b6b3a7640000' } })
    seen = []

    await expect(sendTransaction(new Rpc({ url }), account, { to: TO })).rejects.toThrow(
      /above the ceiling/
    )
    expect(broadcasts()).toHaveLength(0)
  })
})

describe('replacing what is already pending', () => {
  /** A transaction the node has taken and not yet mined, at the quiet-chain fees. */
  const pending = (over: Partial<SentTransaction> = {}): SentTransaction => ({
    hash: '0xabc',
    nonce: 7n,
    gas: 26_250n,
    to: TO,
    value: 1000n,
    data: '0x',
    maxFeePerGas: 15n,
    maxPriorityFeePerGas: 1n,
    wait: () => Promise.reject(new Error('not used')),
    ...over
  })

  const unmined = (over: Record<string, unknown> = {}) =>
    happyNode({ eth_getTransactionReceipt: null, ...over })

  it('sends the same call again at a higher price', async () => {
    handler = unmined()
    seen = []

    const faster = await speedUp(new Rpc({ url }), account, pending())

    // Ten percent of fifteen wei is one and a half, and a node compares with
    // integer arithmetic — so it rounds up or the replacement is not one.
    expect(faster.maxFeePerGas).toBe(17n)
    expect(faster.maxPriorityFeePerGas).toBe(2n)

    const parsed = parseTransaction(latest())
    expect(parsed.nonce).toBe(7)
    expect(parsed.to?.toLowerCase()).toBe(TO.toLowerCase())
    expect(parsed.value).toBe(1000n)
    expect(parsed.gas).toBe(26_250n)
    expect(parsed.maxFeePerGas).toBe(17n)
    expect(parsed.maxPriorityFeePerGas).toBe(2n)
  })

  it('neither re-estimates nor re-prices what it is repeating', async () => {
    handler = unmined()
    seen = []

    await speedUp(new Rpc({ url }), account, pending())

    expect(methods()).not.toContain('eth_estimateGas')
    expect(methods()).not.toContain('eth_getTransactionCount')
    expect(methods()).not.toContain('eth_getBlockByNumber')
  })

  it('takes a larger bump when asked for one', async () => {
    handler = unmined()
    seen = []

    const faster = await speedUp(new Rpc({ url }), account, pending(), 50n)
    expect(faster.maxFeePerGas).toBe(23n)
    expect(faster.maxPriorityFeePerGas).toBe(2n)
  })

  it('raises a zero tip by a whole wei, since a share of nothing is nothing', async () => {
    handler = unmined()
    seen = []

    const faster = await speedUp(new Rpc({ url }), account, pending({ maxPriorityFeePerGas: 0n }))
    expect(faster.maxPriorityFeePerGas).toBe(1n)
  })

  it('can itself be sped up again', async () => {
    handler = unmined()
    seen = []
    const rpc = new Rpc({ url })

    const faster = await speedUp(rpc, account, pending())
    const faster2 = await speedUp(rpc, account, faster)

    expect(faster2.maxFeePerGas).toBe(19n)
    expect(faster2.maxPriorityFeePerGas).toBe(3n)
    expect(parseTransaction(latest()).nonce).toBe(7)
  })

  it('refuses a bump a node would drop, before spending a round trip', async () => {
    handler = unmined()
    seen = []

    await expect(speedUp(new Rpc({ url }), account, pending(), 5n)).rejects.toThrow(/at least 10%/)
    await expect(cancel(new Rpc({ url }), account, pending(), 0n)).rejects.toThrow(/at least 10%/)
    expect(seen).toHaveLength(0)
  })

  it('refuses a bump that would take the fee past the ceiling', async () => {
    handler = unmined()
    seen = []

    await expect(
      speedUp(new Rpc({ url }), account, pending({ maxFeePerGas: FEE_PER_GAS_CEILING }))
    ).rejects.toThrow(/above the ceiling/)
    expect(broadcasts()).toHaveLength(0)
  })

  it('refuses to replace something already mined', async () => {
    // happyNode's receipt is a mined one, which is the whole point here.
    handler = happyNode()
    seen = []

    await expect(speedUp(new Rpc({ url }), account, pending())).rejects.toThrow(
      /already mined in block 16/
    )
    await expect(cancel(new Rpc({ url }), account, pending())).rejects.toThrow(/nonce is spent/)
    expect(broadcasts()).toHaveLength(0)
  })

  it('cancels by paying itself nothing at the same nonce', async () => {
    handler = unmined()
    seen = []

    const cancelled = await cancel(new Rpc({ url }), account, pending())

    expect(cancelled.to).toBe(account.address)
    expect(cancelled.value).toBe(0n)
    expect(cancelled.nonce).toBe(7n)
    // The intrinsic cost of a transfer with nothing in it, not an estimate.
    expect(cancelled.gas).toBe(21_000n)
    expect(methods()).not.toContain('eth_estimateGas')

    const parsed = parseTransaction(latest())
    expect(parsed.nonce).toBe(7)
    expect(parsed.to?.toLowerCase()).toBe(account.address.toLowerCase())
    // viem omits both when they are empty, which is what they must be.
    expect(parsed.value).toBeUndefined()
    expect(parsed.data).toBeUndefined()
    expect(parsed.maxFeePerGas).toBe(17n)

    // And it is signed by the account whose nonce it is taking. A cancel signed
    // by anybody else is a transaction that cannot displace anything.
    expect(await recoverTransactionAddress({ serializedTransaction: latest() })).toBe(
      account.address
    )
  })
})

describe('waiting', () => {
  it('polls until the receipt appears', async () => {
    let attempts = 0
    handler = happyNode({
      eth_getTransactionReceipt: () => {
        attempts += 1
        return attempts < 3
          ? null
          : {
              transactionHash: '0xabc',
              blockNumber: '0x10',
              gasUsed: '0x5208',
              effectiveGasPrice: '0x8',
              status: '0x1'
            }
      }
    })

    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO })
    const receipt = await sent.wait({ interval: 10 })

    expect(attempts).toBe(3)
    expect(receipt.status).toBe(true)
    expect(receipt.gasUsed).toBe(21_000n)
    expect(receipt.blockNumber).toBe(16n)
  })

  it('reports a revert as mined but failed, not as an error', async () => {
    // A reverted transaction is not a failure to send. It was included, it
    // burned gas, and the nonce is spent — treating it as a network error
    // would invite a resend that costs again.
    handler = happyNode({
      eth_getTransactionReceipt: {
        transactionHash: '0xabc',
        blockNumber: '0x10',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x8',
        status: '0x0'
      }
    })

    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO })
    const receipt = await sent.wait({ interval: 10 })
    expect(receipt.status).toBe(false)
  })

  it('warns against resending when it times out', async () => {
    handler = happyNode({ eth_getTransactionReceipt: null })
    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO })

    await expect(sent.wait({ timeout: 60, interval: 10 })).rejects.toThrow(RpcError)
    await expect(sent.wait({ timeout: 60, interval: 10 })).rejects.toThrow(/do not resend/)
  })

  it('returns null for a hash the node has never seen', async () => {
    handler = happyNode({ eth_getTransactionReceipt: null })
    expect(await new Rpc({ url }).transactionReceipt('0xdead')).toBeNull()
  })
})

describe('waiting for depth', () => {
  const minedAt = (block: string) => ({
    transactionHash: '0xabc',
    blockNumber: block,
    gasUsed: '0x5208',
    effectiveGasPrice: '0x8',
    status: '0x1'
  })

  it('returns at the first receipt without asking how high the chain is', async () => {
    handler = happyNode()
    seen = []

    const receipt = await new Rpc({ url }).waitForReceipt('0xabc', { interval: 10 })

    expect(receipt.blockNumber).toBe(16n)
    expect(methods()).not.toContain('eth_blockNumber')
  })

  it('counts the including block as the first confirmation', async () => {
    // The head sits exactly where the transaction landed, so it is one deep and
    // no deeper. Any other reading of the word disagrees with every explorer.
    handler = happyNode({ eth_blockNumber: '0x10' })
    const rpc = new Rpc({ url })

    const receipt = await rpc.waitForReceipt('0xabc', { confirmations: 1, interval: 10 })
    expect(receipt.blockNumber).toBe(16n)

    await expect(
      rpc.waitForReceipt('0xabc', { confirmations: 2, timeout: 60, interval: 10 })
    ).rejects.toThrow(/mined in block 16/)
  })

  it('waits for blocks to pile on top', async () => {
    let head = 16n
    handler = happyNode({
      eth_blockNumber: () => {
        const answer = head
        head += 1n
        return `0x${answer.toString(16)}`
      }
    })
    seen = []

    const receipt = await new Rpc({ url }).waitForReceipt('0xabc', {
      confirmations: 3,
      interval: 10,
      // Well past what three polls need. Present so that a miscount fails here
      // in a second rather than hanging until something else gives up.
      timeout: 2000
    })

    expect(receipt.blockNumber).toBe(16n)
    // 16, then 17, then 18 — the first head that is three blocks deep.
    expect(methods().filter((method) => method === 'eth_blockNumber')).toHaveLength(3)
  })

  it('counts again from wherever a reorg leaves it', async () => {
    let round = 0
    handler = happyNode({
      eth_getTransactionReceipt: () => {
        round += 1
        if (round === 1) return minedAt('0x10')
        // Back in the mempool, which a chain may do to a block that has already
        // been built on.
        if (round === 2) return null
        return minedAt('0x14')
      },
      eth_blockNumber: () => (round === 1 ? '0x10' : '0x15')
    })

    const receipt = await new Rpc({ url }).waitForReceipt('0xabc', {
      confirmations: 2,
      interval: 10,
      timeout: 2000
    })

    // Block 20, not the 16 it was in to begin with. Depth counted from a block
    // that no longer holds it is a confident wrong answer.
    expect(receipt.blockNumber).toBe(20n)
  })

  it('says it is mined when it runs out of time short of the depth', async () => {
    handler = happyNode({ eth_blockNumber: '0x10' })

    const error = await new Rpc({ url })
      .waitForReceipt('0xabc', { confirmations: 4, timeout: 60, interval: 10 })
      .catch((err: RpcError) => err)

    expect((error as RpcError).message).toMatch(/mined in block 16/)
    // Not the warning for one that was never mined. That one exists because a
    // pending transaction might yet land; this one is already spent.
    expect((error as RpcError).message).not.toMatch(/do not resend/)
  })

  it('carries the depth through from the transaction that was sent', async () => {
    handler = happyNode({ eth_blockNumber: '0x12' })
    const sent = await sendTransaction(new Rpc({ url }), account, { to: TO })
    seen = []

    const receipt = await sent.wait({ confirmations: 3, interval: 10, timeout: 2000 })

    expect(receipt.blockNumber).toBe(16n)
    expect(methods()).toContain('eth_blockNumber')
  })

  it('refuses a depth that is not a whole number of at least one', async () => {
    handler = happyNode()
    const rpc = new Rpc({ url })

    await expect(rpc.waitForReceipt('0xabc', { confirmations: 0 })).rejects.toThrow(/at least 1/)
    await expect(rpc.waitForReceipt('0xabc', { confirmations: -1 })).rejects.toThrow(/at least 1/)
    await expect(rpc.waitForReceipt('0xabc', { confirmations: 1.5 })).rejects.toThrow(
      /whole number/
    )
  })
})

describe('a transaction the node is holding', () => {
  /** What geth returns for a pending EIP-1559 transfer. */
  const raw: Record<string, unknown> = {
    hash: '0xabc',
    from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    to: TO.toLowerCase(),
    nonce: '0x7',
    value: '0x3e8',
    input: '0x',
    gas: '0x668a',
    gasPrice: '0xf',
    maxFeePerGas: '0xf',
    maxPriorityFeePerGas: '0x1',
    blockHash: null,
    blockNumber: null,
    type: '0x2'
  }

  it('reads one that has not been mined, fees and all', async () => {
    // The point of asking: a receipt would be null here, and null is also what
    // a dropped transaction and a hash nobody broadcast look like.
    handler = happyNode({ eth_getTransactionByHash: raw })

    const tx = await new Rpc({ url }).transactionByHash('0xabc')

    expect(tx?.blockNumber).toBeNull()
    expect(tx?.blockHash).toBeNull()
    expect(tx?.nonce).toBe(7n)
    expect(tx?.value).toBe(1000n)
    expect(tx?.gas).toBe(26_250n)
    expect(tx?.maxFeePerGas).toBe(15n)
    expect(tx?.maxPriorityFeePerGas).toBe(1n)
    expect(tx?.to?.toLowerCase()).toBe(TO.toLowerCase())
    expect(tx?.type).toBe(2)
  })

  it('reads one that has been mined', async () => {
    handler = happyNode({
      eth_getTransactionByHash: { ...raw, blockNumber: '0x10', blockHash: '0xbeef' }
    })

    const tx = await new Rpc({ url }).transactionByHash('0xabc')
    expect(tx?.blockNumber).toBe(16n)
    expect(tx?.blockHash).toBe('0xbeef')
  })

  it('returns null for a hash it has never seen', async () => {
    handler = happyNode({ eth_getTransactionByHash: null })
    expect(await new Rpc({ url }).transactionByHash('0xdead')).toBeNull()
  })

  it('reads a legacy transaction, which has no fee caps to report', async () => {
    handler = happyNode({
      eth_getTransactionByHash: {
        ...raw,
        type: '0x0',
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined
      }
    })

    const tx = await new Rpc({ url }).transactionByHash('0xabc')
    expect(tx?.type).toBe(0)
    expect(tx?.gasPrice).toBe(15n)
    expect(tx?.maxFeePerGas).toBeNull()
    expect(tx?.maxPriorityFeePerGas).toBeNull()
  })

  it('sees the replacement at the nonce, not the transaction it replaced', async () => {
    // What a wallet showing "speeding up…" actually reads: the new hash is in
    // the mempool at the same nonce, at the higher price.
    handler = happyNode({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: () => ({ ...raw, maxFeePerGas: '0x11', hash: '0xdef' })
    })
    const rpc = new Rpc({ url })

    const faster = await speedUp(rpc, account, {
      hash: '0xabc',
      nonce: 7n,
      gas: 26_250n,
      to: TO,
      value: 1000n,
      data: '0x',
      maxFeePerGas: 15n,
      maxPriorityFeePerGas: 1n,
      wait: () => Promise.reject(new Error('not used'))
    })

    const tx = await rpc.transactionByHash(faster.hash)
    expect(tx?.nonce).toBe(7n)
    expect(tx?.maxFeePerGas).toBe(17n)
    expect(tx?.blockNumber).toBeNull()
  })
})

describe('upfront cost', () => {
  it('is the ceiling times the limit, plus what is being sent', () => {
    // What the node checks the balance against, and why an oversized gas limit
    // can have a nearly empty account rejected.
    expect(upfrontCost(21_000n, 15n, 1000n)).toBe(316_000n)
    expect(upfrontCost(21_000n, 15n)).toBe(315_000n)
  })
})

describe('settle confirmations', () => {
  it('is three blocks, as one named policy every money move shares', () => {
    // A pin rather than an argument: one confirmation is inclusion, not
    // finality, and the callers that wait this deep — bridge transfers, swaps,
    // wallet sends above the guard's threshold — must never drift apart. If
    // this number ever moves, it moves for all of them at once, here.
    expect(SETTLE_CONFIRMATIONS).toBe(3)
  })
})
