import { describe, expect, it } from 'vitest'
import { fromPrivateKey, type Account } from '@lcai-p2p/chain'
import { SealedStore, SealedStoreError, memoryByteStore, type ByteStore } from './index.js'

// Anvil's first two keys. Public, hold nothing.
const account = fromPrivateKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const other = fromPrivateKey('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

interface Harness {
  readonly store: SealedStore
  readonly bytes: ByteStore
  /** Mutable, so a test can lock the wallet or switch account underneath. */
  readonly identity: { account: Account | null }
  readonly reported: Array<[string, string]>
}

function sealedStore(options: { bytes?: ByteStore; purpose?: string } = {}): Harness {
  const bytes = options.bytes ?? memoryByteStore()
  const identity: { account: Account | null } = { account }
  const reported: Array<[string, string]> = []

  const store = new SealedStore(bytes, {
    account: () => identity.account,
    purpose: options.purpose ?? 'local state',
    onDamaged: (name, reason) => {
      reported.push([name, reason])
    }
  })

  return { store, bytes, identity, reported }
}

/**
 * The name the byte store actually saw, found by watching what appeared.
 *
 * It is not the document's name and the tests must not assume it is: a
 * document is stored under a prefix belonging to the identity that wrote it,
 * which is the whole reason two accounts do not tread on each other.
 */
function entryAdded(bytes: ByteStore, before: string[]): string {
  const added = bytes.list().filter((entry) => !before.includes(entry))
  expect(added).toHaveLength(1)
  return added[0] as string
}

describe('a sealed store', () => {
  it('round trips a document', () => {
    const { store } = sealedStore()
    const drafts = { 'room-a': 'half a sentence', 'room-b': '' }

    expect(store.write('drafts', drafts)).toBe(true)
    expect(store.read('drafts', {})).toEqual(drafts)
  })

  it('gives back the empty value the caller named when there is no document', () => {
    // What empty means is the caller's to say. An absent mute list is `[]` and
    // absent preferences are `{}`, and nothing here can tell which is wanted.
    const { store } = sealedStore()

    expect(store.read('muted', [])).toEqual([])
    expect(store.read('preferences', { notify: true })).toEqual({ notify: true })
    expect(store.read<number | null>('unread', null)).toBeNull()
  })

  it('lists the documents it holds, under the names it was given', () => {
    const { store } = sealedStore()
    store.write('address-book', [])
    store.write('drafts', {})
    store.write('wallet_ledger', [])

    expect(store.list()).toEqual(['address-book', 'drafts', 'wallet_ledger'])
  })

  it('forgets a document when it is deleted', () => {
    const { store } = sealedStore()
    store.write('archived', ['a room'])

    expect(store.delete('archived')).toBe(true)
    expect(store.read('archived', [])).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('is not troubled by deleting something that was never there', () => {
    // First run and second run should not need different code at the caller.
    const { store } = sealedStore()
    expect(store.delete('blocked')).toBe(true)
  })

  it('keeps nothing in the clear', () => {
    const { store, bytes } = sealedStore()
    store.write('address-book', [{ name: 'Ada', address: `0x${'1'.repeat(40)}` }])

    const held = Buffer.concat(
      bytes.list().map((entry) => Buffer.from(bytes.read(entry) ?? new Uint8Array()))
    )
    expect(held.includes(Buffer.from('Ada'))).toBe(false)
    expect(held.includes(Buffer.from('1'.repeat(40)))).toBe(false)
  })

  it('is read by the next store over the same bytes', () => {
    // Nothing is remembered between runs but the phrase, so both the key and
    // the name a document is stored under have to be derivable from scratch.
    const { store, bytes } = sealedStore()
    store.write('preferences', { notify: false })

    expect(sealedStore({ bytes }).store.read('preferences', {})).toEqual({ notify: false })
  })

  it('refuses a purpose that is not one', () => {
    expect(() => sealedStore({ purpose: '   ' })).toThrow(SealedStoreError)
  })

  it('refuses a document name that a directory would not survive', () => {
    // A byte store is probably a directory, and this cannot see far enough
    // down to know whether the name it was handed becomes a path.
    const { store } = sealedStore()

    for (const name of ['', '..', '../secrets', 'rooms/drafts', '.hidden', 'two words', 'a@b']) {
      expect(() => store.read(name, null)).toThrow(SealedStoreError)
      expect(() => store.write(name, {})).toThrow(SealedStoreError)
      expect(() => store.delete(name)).toThrow(SealedStoreError)
    }

    expect(() => store.write('a'.repeat(65), {})).toThrow(SealedStoreError)
    expect(store.write('a'.repeat(64), {})).toBe(true)
  })

  it('refuses to write something JSON cannot hold', () => {
    // Sealing `undefined` would store the word rather than a document, and
    // every read afterwards would call it damaged. Better to say so at the
    // call site than at the next start.
    const { store } = sealedStore()

    expect(() => store.write('drafts', undefined)).toThrow(SealedStoreError)
    expect(store.list()).toEqual([])

    // Null is a value JSON holds, and it round trips like any other.
    expect(store.write('unread', null)).toBe(true)
    expect(store.read<string | null>('unread', 'not read')).toBeNull()
  })
})

describe('a store with no key', () => {
  it('reads as empty, lists nothing, and above all writes nothing', () => {
    // Writing would mean inventing a key, and the only key available without
    // an account is no key. The room registry behaves the same way.
    const { store, bytes, identity } = sealedStore()
    store.write('drafts', { 'room-a': 'saved while unlocked' })
    const held = bytes.list()

    identity.account = null

    expect(store.read('drafts', {})).toEqual({})
    expect(store.list()).toEqual([])
    expect(store.write('drafts', { 'room-a': 'saved while locked' })).toBe(false)
    expect(store.delete('drafts')).toBe(false)
    expect(bytes.list()).toEqual(held)
  })

  it('has everything back when the wallet is unlocked again', () => {
    const { store, identity } = sealedStore()
    store.write('unread', { 'room-a': 4 })

    identity.account = null
    expect(store.read('unread', {})).toEqual({})

    identity.account = account
    expect(store.read('unread', {})).toEqual({ 'room-a': 4 })
  })
})

describe('a document that will not open', () => {
  it('comes back empty rather than stopping the application', () => {
    const { store, bytes, reported } = sealedStore()
    const before = bytes.list()
    store.write('preferences', { notify: true })
    bytes.write(entryAdded(bytes, before), new Uint8Array(64))

    expect(store.read('preferences', { notify: false })).toEqual({ notify: false })
    expect(store.damaged()).toEqual(['preferences'])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.[0]).toBe('preferences')
    expect(reported[0]?.[1]).toMatch(/wrong key, or the data has been altered/)
  })

  it('is reported when it is too short to be sealed data at all', () => {
    const { store, bytes, reported } = sealedStore()
    const before = bytes.list()
    store.write('drafts', { 'room-a': 'lost' })
    bytes.write(entryAdded(bytes, before), new Uint8Array(4))

    expect(store.read('drafts', {})).toEqual({})
    expect(reported[0]?.[1]).toMatch(/too short/)
  })

  it('is still listed, because it exists and the trouble is opening it', () => {
    const { store, bytes } = sealedStore()
    const before = bytes.list()
    store.write('drafts', { 'room-a': 'lost' })
    bytes.write(entryAdded(bytes, before), new Uint8Array(64))

    expect(store.list()).toEqual(['drafts'])
  })

  it('takes the others down with it under no circumstances', () => {
    const { store, bytes } = sealedStore()
    const before = bytes.list()
    store.write('drafts', { 'room-a': 'lost' })
    const drafts = entryAdded(bytes, before)
    store.write('preferences', { notify: true })
    bytes.write(drafts, new Uint8Array(64))

    expect(store.read('drafts', {})).toEqual({})
    expect(store.read('preferences', {})).toEqual({ notify: true })
    expect(store.damaged()).toEqual(['drafts'])
  })

  it('stops being reported once something readable is written over it', () => {
    const { store, bytes } = sealedStore()
    const before = bytes.list()
    store.write('drafts', { 'room-a': 'lost' })
    bytes.write(entryAdded(bytes, before), new Uint8Array(64))
    store.read('drafts', {})

    expect(store.damaged()).toEqual(['drafts'])
    store.write('drafts', { 'room-a': 'written again' })
    expect(store.damaged()).toEqual([])
  })

  it('is not carried across to another identity, whose documents are its own', () => {
    const { store, bytes, identity } = sealedStore()
    const before = bytes.list()
    store.write('drafts', { 'room-a': 'lost' })
    bytes.write(entryAdded(bytes, before), new Uint8Array(64))
    store.read('drafts', {})

    identity.account = other
    expect(store.damaged()).toEqual([])
  })

  it('survives a reporting hook that throws', () => {
    // A hook that cannot log must not become the reason the application will
    // not start, which is the precise failure the empty value exists to stop.
    const bytes = memoryByteStore()
    const seed = sealedStore({ bytes })
    const before = bytes.list()
    seed.store.write('preferences', { notify: true })
    bytes.write(entryAdded(bytes, before), new Uint8Array(64))

    const store = new SealedStore(bytes, {
      account: () => account,
      purpose: 'local state',
      onDamaged: () => {
        throw new Error('the log is not writable either')
      }
    })

    expect(store.read('preferences', {})).toEqual({})
    expect(store.damaged()).toEqual(['preferences'])
  })
})

describe('keys are per document and per identity', () => {
  it('will not open one document as another', () => {
    // The seal authenticates the bytes and says nothing about which document
    // they are. Under one key for the whole store, a drafts file copied over
    // the preferences file would open, and the application would act on it.
    const { store, bytes } = sealedStore()

    const beforeDrafts = bytes.list()
    store.write('drafts', { 'room-a': 'mine' })
    const drafts = entryAdded(bytes, beforeDrafts)

    const beforePreferences = bytes.list()
    store.write('preferences', { notify: true })
    const preferences = entryAdded(bytes, beforePreferences)

    bytes.write(preferences, bytes.read(drafts) as Uint8Array)

    expect(store.read('preferences', {})).toEqual({})
    expect(store.damaged()).toEqual(['preferences'])
  })

  it("will not open one store's document under another store's purpose", () => {
    const bytes = memoryByteStore()
    const state = sealedStore({ bytes, purpose: 'local state' })
    const ledger = sealedStore({ bytes, purpose: 'wallet ledger' })

    const beforeState = bytes.list()
    state.store.write('notes', { from: 'the state store' })
    const stateEntry = entryAdded(bytes, beforeState)

    const beforeLedger = bytes.list()
    ledger.store.write('notes', { from: 'the ledger store' })
    const ledgerEntry = entryAdded(bytes, beforeLedger)

    // Two purposes are two namespaces, so neither store can even see the
    // other's document...
    expect(stateEntry).not.toBe(ledgerEntry)
    expect(state.store.read('notes', {})).toEqual({ from: 'the state store' })
    expect(ledger.store.read('notes', {})).toEqual({ from: 'the ledger store' })

    // ...and putting one where the other looks does not help, because the key
    // is derived from the purpose as well.
    bytes.write(ledgerEntry, bytes.read(stateEntry) as Uint8Array)
    expect(ledger.store.read('notes', {})).toEqual({})
    expect(ledger.store.damaged()).toEqual(['notes'])
  })

  it('gives a second account its own documents, and leaves the first alone', () => {
    // Switching account changes every derived key, so the documents of one
    // identity are closed to the other. They must not share a name either: the
    // second to write would replace a file the first can still open, and
    // switching back would find it gone.
    const { store, identity } = sealedStore()
    store.write('drafts', { 'room-a': "the first account's" })

    identity.account = other
    expect(store.read('drafts', {})).toEqual({})
    expect(store.list()).toEqual([])
    store.write('drafts', { 'room-a': "the second account's" })

    identity.account = account
    expect(store.read('drafts', {})).toEqual({ 'room-a': "the first account's" })
    expect(store.list()).toEqual(['drafts'])
  })

  it('does not write the address into the names on disk', () => {
    // Separating the two identities is the job; publishing a list of which
    // accounts this machine holds, to anyone who can read the directory, is
    // not part of it.
    const { store, bytes } = sealedStore()
    store.write('drafts', {})

    const names = bytes.list().join(' ')
    expect(names.toLowerCase()).not.toContain(account.address.slice(2).toLowerCase())
  })
})
