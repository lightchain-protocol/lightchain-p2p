import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Rpc, RpcError, fromPrivateKey, sendTransaction, upfrontCost } from './index.js'

/**
 * A real HTTP server standing in for a node, so the paths that only appear
 * against one — a pending receipt, a reverted transaction, a node that has
 * never heard of a hash — are reachable rather than argued about.
 */

// Anvil's first key. Public, holds nothing.
const account = fromPrivateKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
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
      const { id, method, params } = JSON.parse(body)
      seen.push({ method, params })
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

describe('upfront cost', () => {
  it('is the ceiling times the limit, plus what is being sent', () => {
    // What the node checks the balance against, and why an oversized gas limit
    // can have a nearly empty account rejected.
    expect(upfrontCost(21_000n, 15n, 1000n)).toBe(316_000n)
    expect(upfrontCost(21_000n, 15n)).toBe(315_000n)
  })
})
