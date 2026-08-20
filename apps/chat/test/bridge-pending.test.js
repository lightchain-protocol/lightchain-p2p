import { describe, expect, it } from 'vitest'
import { bridgeHandlers, createPendingStore } from '../workers/handlers/bridge.mjs'

/**
 * The bridge's in-flight transfers, kept worker-side.
 *
 * These used to live in page memory, which is exactly as durable as the page:
 * closing the window on a bridge no explorer indexes lost the hash, the
 * direction and the arrival baseline with it. The store is what makes a
 * reopened page able to pick the transfer back up, so the round trip —
 * written by one session, read by the next — is the thing worth proving.
 */

function memoryState() {
  const docs = new Map()
  return {
    read: (name, empty) => (docs.has(name) ? docs.get(name) : empty),
    write: (name, value) => docs.set(name, value)
  }
}

function transfer(overrides = {}) {
  return {
    hash: `0x${'cd'.repeat(32)}`,
    fromChainId: 1,
    toChainId: 9200,
    fromName: 'Ethereum',
    toName: 'Lightchain',
    amount: '1000000000000000000',
    at: 1_750_000_000_000,
    explorerUrl: 'https://etherscan.io/tx/0x' + 'cd'.repeat(32),
    dispatchId: `0x${'ab'.repeat(32)}`,
    before: null,
    ...overrides
  }
}

describe('the pending bridge store', () => {
  it('round-trips a transfer across sessions', () => {
    const localState = memoryState()

    // One session writes it, the way bridge.send does.
    createPendingStore(localState).add(transfer())

    // The next session — a fresh store over the same documents — reads it back.
    const reopened = createPendingStore(localState)
    expect(reopened.all()).toEqual([transfer()])
  })

  it('keeps the newest first and drops a record that is not one', () => {
    const localState = memoryState()
    const store = createPendingStore(localState)

    store.add(transfer({ hash: `0x${'01'.repeat(32)}`, at: 1 }))
    store.add(transfer({ hash: `0x${'02'.repeat(32)}`, at: 2 }))
    store.add({ hash: 'not a transfer' })

    expect(store.all().map((each) => each.at)).toEqual([2, 1])
  })

  it('replaces rather than duplicates a hash sent twice', () => {
    const localState = memoryState()
    const store = createPendingStore(localState)

    store.add(transfer({ at: 1 }))
    store.add(transfer({ at: 2 }))

    expect(store.all()).toHaveLength(1)
    expect(store.all()[0].at).toBe(2)
  })

  it('sets the arrival baseline after the send and clears on arrival', () => {
    const localState = memoryState()
    const store = createPendingStore(localState)

    store.add(transfer())
    store.setBaseline(transfer().hash, '5000000000000000000')
    expect(createPendingStore(localState).all()[0].before).toBe('5000000000000000000')

    store.clear(transfer().hash)
    expect(createPendingStore(localState).all()).toEqual([])
  })
})

describe('the bridge.pending request', () => {
  function handlersOver(localState) {
    return bridgeHandlers({
      wallet: { status: () => ({ address: `0x${'1'.repeat(40)}` }) },
      localState,
      poolFor: () => {
        throw new Error('no chain should be asked about pending transfers')
      },
      guard: { allow: async () => {} }
    })
  }

  it('answers empty when nothing is in flight', () => {
    expect(handlersOver(memoryState())['bridge.pending']()).toEqual({ pending: [] })
  })

  it('carries the baseline update and the clear, answering with the list', () => {
    const localState = memoryState()
    createPendingStore(localState).add(transfer())

    const handlers = handlersOver(localState)

    const updated = handlers['bridge.pending']({ hash: transfer().hash, before: '42' })
    expect(updated.pending[0].before).toBe('42')

    expect(handlers['bridge.pending']({ clear: transfer().hash })).toEqual({ pending: [] })
  })

  it('serves the same records as bridge.history', () => {
    const localState = memoryState()
    createPendingStore(localState).add(transfer())

    const handlers = handlersOver(localState)
    expect(handlers['bridge.history']()).toEqual({ transfers: [transfer()] })
  })
})
