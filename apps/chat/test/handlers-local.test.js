import { describe, expect, it } from 'vitest'
import { SealedStore, memoryByteStore } from '@lcai-p2p/wallet'
import { localHandlers } from '../workers/handlers/local.mjs'

/**
 * The local-state handler's fail-closed tests.
 *
 * Everything here is sealed under the unlocked account, so the seam under test
 * is a real `SealedStore` over an in-memory byte store rather than a mock of
 * one: the `written:false` contract — a locked wallet writes nothing and reads
 * back the empty shape, never the change that was asked for — only means
 * something if the store genuinely refuses. The rest is the validation that
 * keeps a renderer's garbage out of a sealed file: a malformed key is not a
 * failed lookup, it is an entry nothing will ever match again.
 */

const account = {
  address: `0x${'33'.repeat(20)}`,
  signMessage: () => `0x${'ab'.repeat(65)}`
}

const ROOM = 'aa'.repeat(32)
const ROOM_B = 'bb'.repeat(32)
const ADDR = `0x${'44'.repeat(20)}`
const ADDR_B = `0x${'55'.repeat(20)}`

function stateWith(unlocked = true) {
  return new SealedStore(memoryByteStore(), {
    purpose: 'test local state',
    account: () => (unlocked ? account : null)
  })
}

const handlersFor = (unlocked = true) => {
  const localState = stateWith(unlocked)
  return { handlers: localHandlers({ localState }), localState }
}

describe('local.write, the escape hatch', () => {
  it('refuses to overwrite the documents the local.* handlers maintain', () => {
    const { handlers } = handlersFor()

    for (const name of ['unread', 'drafts', 'moderation', 'notifications', 'contacts', 'templates']) {
      expect(() => handlers['local.write']({ name, document: {} })).toThrow(
        `"${name}" is maintained by the local.* handlers`
      )
    }
  })

  it('refuses the names other handlers own in the same sealed store', () => {
    const { handlers } = handlersFor()

    // `transactions` above all: it is the only record of what this application
    // has ever spent, and an overwrite from here is gone for good.
    for (const name of ['transactions', 'limits', 'roomcontext', 'bridge']) {
      expect(() => handlers['local.write']({ name, document: {} })).toThrow(
        `"${name}" is maintained by the local.* handlers`
      )
    }
  })

  it('writes, reads back, and deletes a free document', () => {
    const { handlers, localState } = handlersFor()

    expect(handlers['local.write']({ name: 'scratch', document: { a: 1 } })).toEqual({
      written: true
    })
    expect(handlers['local.read']({ name: 'scratch' })).toEqual({ document: { a: 1 } })

    expect(handlers['local.write']({ name: 'scratch', document: null })).toEqual({ written: true })
    expect(localState.read('scratch', null)).toBeNull()
  })

  it('refuses a write with no document at all', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.write']({ name: 'scratch' })).toThrow(/nothing to write/)
  })

  it('refuses a missing or blank document name', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.read']({})).toThrow(/which document/)
    expect(() => handlers['local.read']({ name: '  ' })).toThrow(/which document/)
    expect(() => handlers['local.read']({ name: 42 })).toThrow(/which document/)
  })

  it('refuses a document past the size bound', () => {
    const { handlers } = handlersFor()
    const document = { bulk: 'x'.repeat(128 * 1024) }
    expect(() => handlers['local.write']({ name: 'bulk', document })).toThrow(
      /may not exceed 131072 characters/
    )
  })

  it('refuses a 65th document but still lets an existing one change', () => {
    const { handlers } = handlersFor()

    for (let i = 0; i < 64; i++) handlers['local.write']({ name: `doc-${i}`, document: i })

    expect(() => handlers['local.write']({ name: 'doc-64', document: 64 })).toThrow(
      /holds 64 local documents already/
    )
    // The cap traps nobody: rewriting a held name, and clearing one, still work.
    expect(handlers['local.write']({ name: 'doc-0', document: 'again' })).toEqual({ written: true })
    expect(handlers['local.write']({ name: 'doc-0', document: null })).toEqual({ written: true })
  })
})

describe('local.markRead', () => {
  it('refuses a malformed room key before anything is stored', () => {
    const { handlers, localState } = handlersFor()

    expect(() => handlers['local.markRead']({ room: 'not-a-key', count: 1 })).toThrow(
      /not a room key: 64 hex characters/
    )
    expect(localState.read('unread', {})).toEqual({})
  })

  it('stores where somebody read up to and how much is waiting', () => {
    const { handlers } = handlersFor()

    const reply = handlers['local.markRead']({ room: ROOM.toUpperCase(), messageId: 'm-7', count: 3 })

    expect(reply.written).toBe(true)
    expect(reply.unread[ROOM]).toEqual({ lastReadId: 'm-7', count: 3 })
    expect(handlers['local.unread']().unread[ROOM]).toEqual({ lastReadId: 'm-7', count: 3 })
  })

  it('clamps an impossible count rather than refusing the write', () => {
    const { handlers } = handlersFor()

    const huge = handlers['local.markRead']({ room: ROOM, messageId: 'm-1', count: 5_000_000 })
    expect(huge.unread[ROOM].count).toBe(1_000_000)

    // Nothing waiting and nowhere read is what an absent entry already says.
    const cleared = handlers['local.markRead']({ room: ROOM, count: -5 })
    expect(cleared.written).toBe(true)
    expect(cleared.unread[ROOM]).toBeUndefined()
  })

  it('refuses a bookmark over the id bound', () => {
    const { handlers } = handlersFor()
    expect(() =>
      handlers['local.markRead']({ room: ROOM, messageId: 'x'.repeat(129), count: 1 })
    ).toThrow(/may not exceed 128 characters/)
  })

  it('answers written:false with the empty shape while locked', () => {
    const { handlers, localState } = handlersFor(false)

    const reply = handlers['local.markRead']({ room: ROOM, messageId: 'm-1', count: 3 })

    expect(reply).toEqual({ written: false, unread: {} })
    expect(handlers['local.unread']()).toEqual({ unread: {} })
    expect(localState.list()).toEqual([])
  })
})

describe('local.draft', () => {
  it('refuses a draft that is not text', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.draft']({ room: ROOM, text: 42 })).toThrow(/a draft is text/)
  })

  it('refuses a draft longer than the longest message a room will carry', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.draft']({ room: ROOM, text: 'x'.repeat(4097) })).toThrow(
      /may not exceed 4096 characters/
    )
  })

  it('keeps the text exactly as typed and clears on whitespace alone', () => {
    const { handlers } = handlersFor()

    const saved = handlers['local.draft']({ room: ROOM, text: 'half a sentence ' })
    expect(saved.written).toBe(true)
    // The trailing space is where somebody left the cursor; it survives.
    expect(saved.drafts[ROOM]).toBe('half a sentence ')

    const cleared = handlers['local.draft']({ room: ROOM, text: '   ' })
    expect(cleared.written).toBe(true)
    expect(cleared.drafts[ROOM]).toBeUndefined()
    expect(handlers['local.drafts']()).toEqual({ drafts: {} })
  })

  it('answers written:false with the empty shape while locked', () => {
    const { handlers, localState } = handlersFor(false)

    expect(handlers['local.draft']({ room: ROOM, text: 'hello' })).toEqual({
      written: false,
      drafts: {}
    })
    expect(localState.list()).toEqual([])
  })
})

describe('local.mute', () => {
  it('stores a future instant and treats a past one as unmuted', () => {
    const { handlers } = handlersFor()
    const future = Date.now() + 3_600_000

    const muted = handlers['local.mute']({ room: ROOM, until: future })
    expect(muted.written).toBe(true)
    expect(muted.muted[ROOM]).toBe(future)

    const unmuted = handlers['local.mute']({ room: ROOM, until: Date.now() - 1 })
    expect(unmuted.muted[ROOM]).toBeUndefined()
    expect(handlers['local.muted']()).toEqual({ muted: {} })
  })

  it('clamps a mute to the last instant Date holds', () => {
    const { handlers } = handlersFor()

    const reply = handlers['local.mute']({ room: ROOM, until: Number.MAX_SAFE_INTEGER })

    expect(reply.muted[ROOM]).toBe(8_640_000_000_000_000)
  })

  it('refuses a moment that is not a number', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.mute']({ room: ROOM, until: 'tomorrow' })).toThrow(
      /unix timestamp in milliseconds, or null to unmute/
    )
  })

  it('answers written:false with the empty shape while locked', () => {
    const { handlers } = handlersFor(false)

    expect(handlers['local.mute']({ room: ROOM, until: Date.now() + 1000 })).toEqual({
      written: false,
      muted: {}
    })
  })
})

describe('local.block', () => {
  it('stores the lowercase spelling of a checksummed address, once', () => {
    const { handlers } = handlersFor()
    const checksummed = `0x${'Aa'.repeat(20)}`

    const reply = handlers['local.block']({ address: checksummed })

    expect(reply.written).toBe(true)
    expect(reply.blocked).toEqual([`0x${'aa'.repeat(20)}`])
  })

  it('blocks by default, unblocks on explicit false, and keeps the list sorted', () => {
    const { handlers } = handlersFor()

    handlers['local.block']({ address: ADDR_B })
    const reply = handlers['local.block']({ address: ADDR })
    expect(reply.blocked).toEqual([ADDR, ADDR_B])

    const unblocked = handlers['local.block']({ address: ADDR, on: false })
    expect(unblocked.blocked).toEqual([ADDR_B])
  })

  it('refuses a malformed address', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.block']({ address: '0x123' })).toThrow(
      /not an address: 0x and 40 hex characters/
    )
  })

  it('answers written:false with the empty shape while locked', () => {
    const { handlers } = handlersFor(false)

    expect(handlers['local.block']({ address: ADDR })).toEqual({ written: false, blocked: [] })
  })
})

describe('local.archive', () => {
  it('archives by default and takes the room back out on explicit false', () => {
    const { handlers } = handlersFor()

    expect(handlers['local.archive']({ room: ROOM }).archived).toEqual([ROOM])
    expect(handlers['local.archive']({ room: ROOM_B }).archived).toEqual([ROOM, ROOM_B])
    expect(handlers['local.archive']({ room: ROOM, on: false }).archived).toEqual([ROOM_B])
    expect(handlers['local.archived']()).toEqual({ archived: [ROOM_B] })
  })

  it('answers written:false with the empty shape while locked', () => {
    const { handlers } = handlersFor(false)
    expect(handlers['local.archive']({ room: ROOM })).toEqual({ written: false, archived: [] })
  })
})

describe('notification preferences', () => {
  it('reads back the defaults when nothing is stored', () => {
    const { handlers } = handlersFor()

    expect(handlers['local.notificationPreferences']()).toEqual({
      preferences: { enabled: true, sound: true, rooms: {} }
    })
  })

  it('patches one switch and leaves the rest alone', () => {
    const { handlers } = handlersFor()

    const reply = handlers['local.notifications']({ preferences: { enabled: false } })

    expect(reply.written).toBe(true)
    expect(reply.preferences).toEqual({ enabled: false, sound: true, rooms: {} })
  })

  it('sets, keeps, and clears a per-room override', () => {
    const { handlers } = handlersFor()

    const set = handlers['local.notifications']({ preferences: { rooms: { [ROOM]: { sound: false } } } })
    expect(set.preferences.rooms[ROOM]).toEqual({ sound: false })

    // A patch that says nothing changes nothing: the override merges into what
    // the room already had rather than replacing it.
    const untouched = handlers['local.notifications']({ preferences: { rooms: { [ROOM]: {} } } })
    expect(untouched.preferences.rooms[ROOM]).toEqual({ sound: false })

    handlers['local.notifications']({ preferences: { rooms: { [ROOM]: { enabled: false } } } })
    const cleared = handlers['local.notifications']({ preferences: { rooms: { [ROOM]: null } } })
    expect(cleared.preferences.rooms[ROOM]).toBeUndefined()
  })

  it('refuses a malformed room key inside the rooms patch', () => {
    const { handlers, localState } = handlersFor()

    expect(() =>
      handlers['local.notifications']({ preferences: { rooms: { bogus: { enabled: false } } } })
    ).toThrow(/not a room key/)
    expect(localState.read('notifications', {})).toEqual({})
  })

  it('refuses a rooms patch that is not an object', () => {
    const { handlers } = handlersFor()
    expect(() => handlers['local.notifications']({ preferences: { rooms: 'all of them' } })).toThrow(
      /object keyed by room key/
    )
    expect(() =>
      handlers['local.notifications']({ preferences: { rooms: { [ROOM]: 'off' } } })
    ).toThrow(/\{ enabled, sound \} or null/)
  })

  it('answers written:false with the defaults while locked', () => {
    const { handlers } = handlersFor(false)

    const reply = handlers['local.notifications']({ preferences: { enabled: false } })

    expect(reply.written).toBe(false)
    expect(reply.preferences).toEqual({ enabled: true, sound: true, rooms: {} })
  })
})

describe('templates', () => {
  it('needs a name and a body, within the bounds', () => {
    const { handlers } = handlersFor()

    expect(() => handlers['local.saveTemplate']({ name: '', body: 'x' })).toThrow(/needs a name/)
    expect(() => handlers['local.saveTemplate']({ name: 'x'.repeat(65), body: 'x' })).toThrow(
      /name may not exceed 64/
    )
    expect(() => handlers['local.saveTemplate']({ name: 't', body: '  ' })).toThrow(
      /needs something in it/
    )
    expect(() => handlers['local.saveTemplate']({ name: 't', body: 'x'.repeat(4097) })).toThrow(
      /may not exceed 4096/
    )
  })

  it('saves, updates by id, removes, and lists sorted by name', () => {
    const { handlers } = handlersFor()

    const first = handlers['local.saveTemplate']({ name: 'beta', body: 'second added' })
    const second = handlers['local.saveTemplate']({ name: 'alpha', body: 'first added' })

    expect(first.written).toBe(true)
    expect(second.templates.map((t) => t.name)).toEqual(['alpha', 'beta'])

    const id = second.templates[0].id
    const updated = handlers['local.saveTemplate']({ id, name: 'alpha', body: 'rewritten' })
    expect(updated.templates).toHaveLength(2)
    expect(updated.templates[0]).toEqual({ id, name: 'alpha', body: 'rewritten' })

    const removed = handlers['local.removeTemplate']({ id })
    expect(removed.written).toBe(true)
    expect(removed.templates.map((t) => t.name)).toEqual(['beta'])

    expect(handlers['local.removeTemplate']({ id: 'missing' }).written).toBe(false)
  })

  it('refuses a 101st template', () => {
    const { handlers } = handlersFor()

    for (let i = 0; i < 100; i++) handlers['local.saveTemplate']({ name: `t-${i}`, body: 'x' })

    expect(() => handlers['local.saveTemplate']({ name: 'one more', body: 'x' })).toThrow(
      /room for 100 templates/
    )
  })

  it('answers written:false with an empty list while locked', () => {
    const { handlers } = handlersFor(false)

    expect(handlers['local.saveTemplate']({ name: 't', body: 'x' })).toEqual({
      written: false,
      templates: []
    })
  })
})

describe('contacts', () => {
  it('stores the lowercase address and a collapsed, bounded label', () => {
    const { handlers } = handlersFor()

    const reply = handlers['local.addContact']({
      address: `0x${'Bb'.repeat(20)}`,
      label: '  some\tone\nwe know  '
    })

    expect(reply.written).toBe(true)
    expect(reply.contacts).toEqual([{ address: `0x${'bb'.repeat(20)}`, label: 'some one we know' }])
  })

  it('refuses a malformed address and an overlong label', () => {
    const { handlers } = handlersFor()

    expect(() => handlers['local.addContact']({ address: 'nope' })).toThrow(/not an address/)
    expect(() => handlers['local.addContact']({ address: ADDR, label: 'x'.repeat(65) })).toThrow(
      /may not exceed 64 characters, and this one is 65/
    )
    expect(() => handlers['local.addContact']({ address: ADDR, label: 7 })).toThrow(
      /a contact label is text/
    )
  })

  it('allows an empty label, removes contacts, and lists sorted by label', () => {
    const { handlers } = handlersFor()

    handlers['local.addContact']({ address: ADDR_B, label: 'zebra' })
    handlers['local.addContact']({ address: ADDR, label: '' })

    // Empty labels sort first; saved-but-unnamed is a real state.
    expect(handlers['local.contacts']().contacts).toEqual([
      { address: ADDR, label: '' },
      { address: ADDR_B, label: 'zebra' }
    ])

    const removed = handlers['local.removeContact']({ address: ADDR })
    expect(removed.contacts).toEqual([{ address: ADDR_B, label: 'zebra' }])
  })

  it('answers written:false with an empty list while locked', () => {
    const { handlers } = handlersFor(false)

    expect(handlers['local.addContact']({ address: ADDR, label: 'x' })).toEqual({
      written: false,
      contacts: []
    })
    expect(handlers['local.removeContact']({ address: ADDR })).toEqual({
      written: false,
      contacts: []
    })
  })
})

describe('reading what an older release wrote', () => {
  it('drops unrecognisable unread entries on the way out', () => {
    const { handlers, localState } = handlersFor()

    localState.write('unread', {
      'not-a-room-key': { lastReadId: 'm-1', count: 5 },
      [ROOM]: { lastReadId: 'x'.repeat(200), count: 3 },
      [ROOM_B]: 'garbage'
    })

    expect(handlers['local.unread']().unread).toEqual({
      [ROOM]: { lastReadId: 'x'.repeat(128), count: 3 }
    })
  })

  it('drops mutes that have already run out as the document is read', () => {
    const { handlers, localState } = handlersFor()

    localState.write('moderation', {
      muted: { [ROOM]: Date.now() - 1000, [ROOM_B]: Date.now() + 60_000 },
      blocked: ['not an address', ADDR.toUpperCase()],
      archived: { not: 'a list' }
    })

    expect(handlers['local.muted']().muted).toEqual({ [ROOM_B]: expect.any(Number) })
    expect(handlers['local.blocked']().blocked).toEqual([ADDR])
    expect(handlers['local.archived']().archived).toEqual([])
  })

  it('reads a contacts document that has become a number as an empty book', () => {
    const { handlers, localState } = handlersFor()

    localState.write('contacts', 42)

    expect(handlers['local.contacts']()).toEqual({ contacts: [] })
  })
})
