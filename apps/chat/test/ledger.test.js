import { describe, expect, it, vi } from 'vitest'
import { recordTransaction, transactionLedger } from '../workers/ledger.mjs'

/**
 * The ledger, and above all the seam A7 codes against: `recordTransaction`
 * takes the sending chain's client explicitly, so a transaction broadcast to
 * another chain is recorded with that chain's id rather than the connected
 * one. The reconcile pass predates the extraction and is tested here to prove
 * the move changed nothing about it.
 */

const ADDRESS = `0x${'11'.repeat(20)}`
const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const TO = `0x${'22'.repeat(20)}`

/** A sealed store that is only sealed in spirit: a Map with the same shape. */
function memoryStore() {
  const documents = new Map()
  return {
    read: (name, fallback) => documents.get(name) ?? fallback,
    write: (name, document) => {
      documents.set(name, document)
      return true
    }
  }
}

/**
 * A context good enough for the ledger: the store, the connected chain's
 * client, and the wallet's address. The `chainId` on the rpc is a spy so a
 * test can prove which client was asked.
 */
function context({ chainId = 9200, rpcOver = {} } = {}) {
  const rpc = {
    chainId: vi.fn(async () => chainId),
    send: vi.fn(async () => '0x0'),
    transactionReceipt: vi.fn(async () => null),
    transactionByHash: vi.fn(async () => null),
    blockNumber: vi.fn(async () => 100n),
    ...rpcOver
  }

  const ctx = {
    localState: memoryStore(),
    rpc: () => rpc,
    network: () => 'mainnet',
    wallet: { status: () => ({ address: ADDRESS }) }
  }

  return { ctx, rpc }
}

/** A sent transaction, as sendTransaction returns one, without a chain. */
function sent(over = {}) {
  return {
    hash: HASH_A,
    to: TO,
    value: 5n,
    data: '0x',
    gas: 21_000n,
    maxFeePerGas: 5n,
    maxPriorityFeePerGas: 1n,
    nonce: 3n,
    // Never settles: follow() is background work, and a pending promise keeps
    // it out of the test's way.
    wait: vi.fn(() => new Promise(() => {})),
    ...over
  }
}

const receipt = (over = {}) => ({
  status: true,
  blockNumber: 12n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
  ...over
})

describe('recording against an explicit chain client', () => {
  it('records the chain id of the client it is given, not the connected one', async () => {
    const { ctx, rpc } = context({ chainId: 9200 })
    // A swap broadcast to Ethereum is recorded with the Ethereum client, even
    // though the wallet is connected to Lightchain.
    const ethereum = { chainId: vi.fn(async () => 1) }

    const entry = await recordTransaction(ctx, ethereum, { kind: 'swap', ...sent() })

    expect(entry.chainId).toBe(1)
    expect(ethereum.chainId).toHaveBeenCalledTimes(1)
    expect(rpc.chainId).not.toHaveBeenCalled()
  })

  it('still records the connected chain when that is the client passed', async () => {
    const { ctx, rpc } = context({ chainId: 9200 })

    const entry = await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })

    expect(entry.chainId).toBe(9200)
    expect(entry.kind).toBe('send')
    expect(entry.status).toBe('pending')
    expect(entry.from).toBe(ADDRESS)
    // Quantities cross into the document as decimal strings, as they cross
    // out of it in replies.
    expect(entry.value).toBe('5')
    expect(entry.nonce).toBe('3')
    expect(entry.network).toBe('mainnet')
  })

  it("honours an explicit fallback when the sending chain's client will not say", async () => {
    const { ctx } = context()
    const silent = { chainId: vi.fn(async () => Promise.reject(new Error('node down'))) }

    const entry = await recordTransaction(ctx, silent, {
      kind: 'bridge',
      ...sent(),
      fallbackChainId: 1
    })

    expect(entry.chainId).toBe(1)
  })

  it('falls back to the connected network’s table entry without one', async () => {
    // The pre-extraction behaviour: a Lightchain send whose chainId() call
    // failed was still recorded as Lightchain, from NETWORKS.
    const { ctx } = context()
    const silent = { chainId: vi.fn(async () => Promise.reject(new Error('node down'))) }

    const entry = await recordTransaction(ctx, silent, { kind: 'send', ...sent() })

    expect(entry.chainId).toBe(9200)
  })

  it('writes a hash once, and links a replacement to what it replaces', async () => {
    const { ctx, rpc } = context()

    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    // Recording the same hash again replaces the row rather than duplicating
    // it — a double row reads as a double spend.
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent({ nonce: 4n }) })
    // A speed-up of the original lands linked, and the original says by what.
    await recordTransaction(ctx, rpc, {
      kind: 'send',
      ...sent({ hash: HASH_B, nonce: 3n }),
      replaces: HASH_A
    })

    const entries = transactionLedger(ctx).entries()
    expect(entries.filter((entry) => entry.hash === HASH_A)).toHaveLength(1)
    expect(entries.find((entry) => entry.hash === HASH_A).replacedBy).toBe(HASH_B)
    expect(entries.find((entry) => entry.hash === HASH_B).replaces).toBe(HASH_A)
  })
})

describe('reconciling against the chain', () => {
  it('settles a pending entry from its receipt', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    rpc.transactionReceipt.mockResolvedValue(receipt())

    const entries = await transactionLedger(ctx).reconcile()
    const entry = entries.find((held) => held.hash === HASH_A)

    expect(entry.status).toBe('confirmed')
    expect(entry.block).toBe('12')
    expect(entry.gasUsed).toBe('21000')
    // The fee is what it really cost: gas used times the price paid, not the
    // cap that was offered.
    expect(entry.fee).toBe('42000')
  })

  it('marks a reverted receipt as failed, with the gas still spent', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    rpc.transactionReceipt.mockResolvedValue(receipt({ status: false }))

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('failed')
    expect(entry.fee).toBe('42000')
    expect(entry.detail).toMatch(/reverted/)
  })

  it('marks an unknown hash with a spent nonce as failed, in words', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() }) // nonce 3
    rpc.send.mockResolvedValue('0x4') // four mined: nonce 3 was spent by something else

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('failed')
    expect(entry.detail).toBe(
      'nonce 3 was spent by another transaction, so this one can never be mined'
    )
  })

  it('names the replacement that took the nonce when there is one', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    await recordTransaction(ctx, rpc, {
      kind: 'send',
      ...sent({ hash: HASH_B }),
      replaces: HASH_A
    })
    rpc.send.mockResolvedValue('0x4')

    const entries = await transactionLedger(ctx).reconcile()
    const original = entries.find((entry) => entry.hash === HASH_A)

    expect(original.status).toBe('failed')
    expect(original.detail).toBe(`replaced by ${HASH_B}, which took nonce 3`)
  })

  it('keeps a transaction pending while the node still holds it', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    rpc.transactionByHash.mockResolvedValue({ hash: HASH_A, blockNumber: null })

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('pending')
  })

  it('keeps a forgotten transaction pending while its nonce is still free', async () => {
    // The node has never heard of it, but nothing else has taken the nonce
    // either — it can still be rebroadcast and mined, and calling it dead is
    // how a wallet reports a payment failed shortly before it arrives.
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() }) // nonce 3
    rpc.send.mockResolvedValue('0x3') // three mined: nonce 3 is next, not spent

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('pending')
  })

  it('asks only about entries made on the chain now connected', async () => {
    // An Ethereum entry sits in the same sealed document as the Lightchain
    // ones — the store is scoped per identity, not per chain — and asking
    // Lightchain about it would earn a confident "never heard of it" that
    // reads as a transaction which never happened.
    const { ctx, rpc } = context({ chainId: 9200 })
    const ethereum = { chainId: vi.fn(async () => 1) }
    await recordTransaction(ctx, ethereum, { kind: 'swap', ...sent() })

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('pending')
    expect(rpc.transactionReceipt).not.toHaveBeenCalled()
    expect(rpc.transactionByHash).not.toHaveBeenCalled()
  })

  it('leaves everything pending when there is no node to ask', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    rpc.chainId.mockRejectedValue(new Error('node down'))

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('pending')
  })
})

describe('re-validating settled entries a reorg could still reach', () => {
  /** Settles the recorded entry from its receipt, the way a history read does. */
  async function settleNow(ctx, rpc, perHash = () => receipt()) {
    rpc.transactionReceipt.mockImplementation(async (hash) => perHash(hash))
    await transactionLedger(ctx).reconcile()
    rpc.transactionReceipt.mockClear()
  }

  it('sends a reorged-out entry back to pending rather than leaving a phantom success', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'bridge', ...sent() })
    await settleNow(ctx, rpc) // confirmed at block 12

    // The chain unpicked the block: the hash has no receipt at all now, and
    // the head is close enough that the entry is still inside the window.
    rpc.transactionReceipt.mockResolvedValue(null)
    rpc.blockNumber.mockResolvedValue(20n)

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('pending')
    // The settled fields went with the receipt: no phantom block, gas or fee
    // stands in history while the transaction waits to be mined again.
    expect(entry.block).toBe(null)
    expect(entry.settledAt).toBe(null)
    expect(entry.gasUsed).toBe(null)
    expect(entry.fee).toBe(null)
  })

  it('follows an entry that re-mined in a different block to the new block', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    await settleNow(ctx, rpc) // confirmed at block 12

    // A reorg moved rather than dropped it: the receipt is back, one block on.
    rpc.transactionReceipt.mockResolvedValue(receipt({ blockNumber: 13n }))
    rpc.blockNumber.mockResolvedValue(20n)

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('confirmed')
    expect(entry.block).toBe('13')
  })

  it('re-checks inside the 64-block window and not past it', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent({ hash: HASH_B, nonce: 4n }) })
    await settleNow(ctx, rpc, (hash) => receipt({ blockNumber: hash === HASH_A ? 12n : 13n }))

    // Head 76: A sits 64 deep, exactly at the window's edge and trusted; B
    // sits 63 deep and is asked again. B's receipt is gone — reorged out.
    rpc.blockNumber.mockResolvedValue(76n)
    rpc.transactionReceipt.mockResolvedValue(null)

    const entries = await transactionLedger(ctx).reconcile()

    expect(entries.find((entry) => entry.hash === HASH_A).status).toBe('confirmed')
    expect(entries.find((entry) => entry.hash === HASH_B).status).toBe('pending')
    // The old entry was not even asked about: the window bounds what each
    // history read pays for.
    expect(rpc.transactionReceipt).toHaveBeenCalledTimes(1)
    expect(rpc.transactionReceipt).toHaveBeenCalledWith(HASH_B)
  })

  it('leaves a settled entry alone when the chain cannot say how high it is', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    await settleNow(ctx, rpc)

    // An unreachable head is not evidence of a reorg: nothing is re-checked
    // and nothing moves.
    rpc.blockNumber.mockRejectedValue(new Error('node down'))

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('confirmed')
    expect(entry.block).toBe('12')
    expect(rpc.transactionReceipt).not.toHaveBeenCalled()
  })

  it('leaves a settled entry alone when its receipt cannot be re-read', async () => {
    const { ctx, rpc } = context()
    await recordTransaction(ctx, rpc, { kind: 'send', ...sent() })
    await settleNow(ctx, rpc)

    rpc.blockNumber.mockResolvedValue(20n)
    rpc.transactionReceipt.mockRejectedValue(new Error('node down'))

    const [entry] = await transactionLedger(ctx).reconcile()

    expect(entry.status).toBe('confirmed')
    expect(entry.block).toBe('12')
  })
})
