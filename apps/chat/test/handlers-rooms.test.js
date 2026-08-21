import { describe, expect, it, vi } from 'vitest'
import ID from 'hypercore-id-encoding'
import { MAX_ATTACHMENT_SIZE } from '@lcai-p2p/room'
import { roomHandlers } from '../workers/handlers/rooms.mjs'

/**
 * The room handler's argument-checking tests.
 *
 * Nearly every request here is a sentence of validation in front of a call into
 * `@lcai-p2p/room`, which is tested elsewhere against a real second peer. What
 * is NOT tested there is this file's half of the contract: the refusals that
 * keep a renderer's missing key from surfacing as a failure inside Autobase,
 * the message-target checks that stop an unparseable event from being signed
 * into a permanent log, and the search scan that is genuinely implemented
 * here. The room host is replaced by a spy; nothing touches the network.
 */

const ROOM = 'aa'.repeat(32)
const DHT_KEY = Uint8Array.from({ length: 32 }, () => 7)

function ctxWith({ rooms: roomOver = {}, store = null, attachmentsFor = null } = {}) {
  const rooms = {
    states: vi.fn(async () => []),
    create: vi.fn(async () => ({ key: ROOM })),
    join: vi.fn(async (key) => ({ key })),
    credentials: vi.fn(async () => ({ key: ROOM })),
    lodgingFailures: [],
    send: vi.fn(async () => ({ id: 'm-1' })),
    react: vi.fn(async () => ({})),
    edit: vi.fn(async () => ({})),
    deleteMessage: vi.fn(async () => ({})),
    pin: vi.fn(async () => ({})),
    state: vi.fn(async () => ({ key: ROOM, name: 'one room', conversation: [] })),
    nameSelf: vi.fn(async () => ({})),
    addWriter: vi.fn(async () => ({})),
    removeWriter: vi.fn(async () => ({})),
    rename: vi.fn(async () => ({})),
    setTyping: vi.fn(),
    setRead: vi.fn(),
    setReceipts: vi.fn(),
    presenceOf: vi.fn(() => ({ peers: ['peer-a'] })),
    connections: 3,
    invite: vi.fn(async () => 'invite-string'),
    pair: vi.fn(async () => ({})),
    leave: vi.fn(async () => true),
    ...roomOver
  }

  const ctx = {
    rooms,
    attachmentsFor: attachmentsFor ?? vi.fn(async () => store),
    forgetAttachments: vi.fn(async () => {}),
    swarm: { dht: { defaultKeyPair: { publicKey: DHT_KEY } } }
  }

  return { ctx, rooms }
}

describe('room.join and room.credentials', () => {
  it('refuses a join without both keys', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    expect(() => handlers['room.join']({ encryptionKey: 'enc' })).toThrow(
      /both the room key and its encryption key/
    )
    expect(() => handlers['room.join']({ key: ROOM })).toThrow(
      /both the room key and its encryption key/
    )
    expect(rooms.join).not.toHaveBeenCalled()
  })

  it('forwards both halves of a good join', async () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    await handlers['room.join']({ key: ROOM, encryptionKey: 'enc-key' })

    expect(rooms.join).toHaveBeenCalledWith(ROOM, 'enc-key')
  })

  it('refuses credentials for no room', () => {
    const { ctx } = ctxWith()
    expect(() => roomHandlers(ctx)['room.credentials']({})).toThrow(/which room/)
  })
})

describe('room.send', () => {
  it('refuses a message with nothing in it', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    expect(() => handlers['room.send']({ room: ROOM, text: '   ' })).toThrow(/nothing to send/)
    expect(rooms.send).not.toHaveBeenCalled()
  })

  it('sends a file on its own as a message', async () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)
    const attachment = { ref: 'blob-1' }

    await handlers['room.send']({ room: ROOM, attachment })

    expect(rooms.send).toHaveBeenCalledWith(ROOM, '', { attachment })
  })

  it('passes replyTo through only when it says something', async () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    await handlers['room.send']({ room: ROOM, text: 'hi', replyTo: '' })
    expect(rooms.send).toHaveBeenCalledWith(ROOM, 'hi', {})

    await handlers['room.send']({ room: ROOM, text: 'hi', replyTo: 'm-0' })
    expect(rooms.send).toHaveBeenCalledWith(ROOM, 'hi', { replyTo: 'm-0' })
  })
})

describe('message targets', () => {
  it('refuses a reaction naming no message, before anything is signed', () => {
    // A reaction with no target is an entry that reports success, occupies a
    // permanent log, and means nothing to any reader. There is no second chance.
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    expect(() => handlers['room.react']({ room: ROOM, emoji: '👍' })).toThrow(
      /which message is being reacted to\?/
    )
    expect(rooms.react).not.toHaveBeenCalled()
  })

  it('reacts by default and unreacts only on an explicit false', async () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    await handlers['room.react']({ room: ROOM, target: ' m-1 ', emoji: '👍' })
    expect(rooms.react).toHaveBeenCalledWith(ROOM, 'm-1', '👍', true)

    await handlers['room.react']({ room: ROOM, target: 'm-1', emoji: '👍', on: false })
    expect(rooms.react).toHaveBeenCalledWith(ROOM, 'm-1', '👍', false)
  })

  it('refuses an edit emptied of text, pointing at withdraw instead', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    expect(() => handlers['room.edit']({ room: ROOM, target: 'm-1', text: '  ' })).toThrow(
      /withdraw the message rather than emptying it/
    )
    expect(rooms.edit).not.toHaveBeenCalled()
  })

  it('refuses a withdrawal or pin naming no message', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    expect(() => handlers['room.deleteMessage']({ room: ROOM })).toThrow(
      /which message is being withdrawn\?/
    )
    expect(() => handlers['room.pin']({ room: ROOM, target: '' })).toThrow(
      /which message is being pinned\?/
    )
    expect(rooms.deleteMessage).not.toHaveBeenCalled()
    expect(rooms.pin).not.toHaveBeenCalled()
  })

  it('pins by default and unpins on an explicit false', async () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    await handlers['room.pin']({ room: ROOM, target: 'm-1' })
    expect(rooms.pin).toHaveBeenCalledWith(ROOM, 'm-1', true)

    await handlers['room.pin']({ room: ROOM, target: 'm-1', on: false })
    expect(rooms.pin).toHaveBeenCalledWith(ROOM, 'm-1', false)
  })
})

describe('room.attach', () => {
  const storeWith = () => ({ put: vi.fn(async (bytes, meta) => ({ ref: 'blob', bytes: bytes.length, meta })) })

  it('refuses a request with no files', async () => {
    const { ctx } = ctxWith({ store: storeWith() })
    await expect(roomHandlers(ctx)['room.attach']({ room: ROOM })).rejects.toThrow(
      /no files to attach/
    )
  })

  it('refuses a file that arrived with no bytes, naming it', async () => {
    const store = storeWith()
    const { ctx } = ctxWith({ store })
    const handlers = roomHandlers(ctx)

    await expect(
      handlers['room.attach']({ room: ROOM, files: [{ name: 'photo.png' }] })
    ).rejects.toThrow(/"photo\.png" arrived with no bytes in it/)
    expect(store.put).not.toHaveBeenCalled()
  })

  it('refuses a file past the size cap before a buffer is ever built', async () => {
    // The cap applies to the JSON array, because by the time a buffer exists
    // the same file has been paid for twice. A sparse array stands in for 25
    // MiB of numbers without the test paying for them a third time.
    const store = storeWith()
    const { ctx } = ctxWith({ store })
    const handlers = roomHandlers(ctx)
    const bytes = []
    bytes.length = MAX_ATTACHMENT_SIZE + 1

    await expect(
      handlers['room.attach']({ room: ROOM, files: [{ name: 'huge.bin', bytes }] })
    ).rejects.toThrow(new RegExp(`past the ${MAX_ATTACHMENT_SIZE} byte limit`))
    expect(store.put).not.toHaveBeenCalled()
  })

  it('stores the bytes and returns the references', async () => {
    const store = storeWith()
    const { ctx } = ctxWith({ store })
    const handlers = roomHandlers(ctx)

    const reply = await handlers['room.attach']({
      room: ROOM,
      files: [{ name: 'note.txt', type: 'text/plain', bytes: [104, 105] }]
    })

    expect(store.put).toHaveBeenCalledWith(Uint8Array.from([104, 105]), {
      name: 'note.txt',
      type: 'text/plain'
    })
    expect(reply.attachments).toHaveLength(1)
  })
})

describe('room.fetchAttachment', () => {
  it('refuses a request naming no attachment', async () => {
    const { ctx } = ctxWith({ store: { get: vi.fn() } })
    await expect(roomHandlers(ctx)['room.fetchAttachment']({ room: ROOM })).rejects.toThrow(
      /which attachment\?/
    )
  })

  it('returns the bytes as numbers and what they sniff as, not the claimed type', async () => {
    // A PNG header, whatever the sender labelled it: `type` is a stranger's
    // claim and the sniffed answer is what an interface must decide on.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]
    const store = { get: vi.fn(async () => Uint8Array.from(png)) }
    const { ctx } = ctxWith({ store })
    const handlers = roomHandlers(ctx)

    const reply = await handlers['room.fetchAttachment']({
      room: ROOM,
      attachment: { ref: 'blob', type: 'text/html' }
    })

    expect(reply.bytes).toEqual(png)
    expect(reply.sniffed).toBe('image/png')
  })
})

describe('room.search', () => {
  const message = (over = {}) => ({
    id: 'm-1',
    text: 'nothing about the meeting',
    at: 1000,
    ...over
  })

  const stateWith = (key, conversation) =>
    vi.fn(async () => [
      { key, name: `room ${key.slice(0, 2)}`, conversation }
    ])

  it('refuses an empty query', async () => {
    const { ctx } = ctxWith()
    await expect(roomHandlers(ctx)['room.search']({ query: '  ' })).rejects.toThrow(
      /what are you looking for\?/
    )
  })

  it('matches case-insensitively, newest first, skipping the withdrawn', async () => {
    const { ctx } = ctxWith({
      rooms: {
        states: stateWith(ROOM, [
          message({ id: 'old', text: 'the MEETING moved', at: 1000 }),
          message({ id: 'gone', text: 'meeting cancelled', at: 3000, deletedAt: 3001 }),
          message({ id: 'new', text: 'meeting notes', at: 2000, author: null, verified: true })
        ])
      }
    })

    const reply = await roomHandlers(ctx)['room.search']({ query: 'Meeting' })

    expect(reply.results.map((r) => r.id)).toEqual(['new', 'old'])
    expect(reply.results[0]).toMatchObject({
      room: ROOM,
      author: null,
      verified: true
    })
  })

  it('narrows to one room when a key is given', async () => {
    const { ctx, rooms } = ctxWith({
      rooms: {
        state: vi.fn(async () => ({
          key: ROOM,
          name: 'one room',
          conversation: [message({ text: 'a hit in the one room' })]
        }))
      }
    })

    const reply = await roomHandlers(ctx)['room.search']({ query: 'hit', room: ROOM })

    expect(rooms.state).toHaveBeenCalledWith(ROOM)
    expect(rooms.states).not.toHaveBeenCalled()
    expect(reply.results).toHaveLength(1)
  })

  it('hands back at most 200 hits', async () => {
    const conversation = Array.from({ length: 205 }, (_, i) =>
      message({ id: `m-${i}`, text: 'needle', at: i })
    )
    const { ctx } = ctxWith({ rooms: { states: stateWith(ROOM, conversation) } })

    const reply = await roomHandlers(ctx)['room.search']({ query: 'needle' })

    expect(reply.results).toHaveLength(200)
    // The hits kept are the newest.
    expect(reply.results[0].id).toBe('m-204')
  })
})

describe('room.pair, the invite people actually paste', () => {
  it.each([
    ['lightchain://abc123', 'abc123'],
    ['lightchain://room/abc123', 'abc123'],
    ['LIGHTCHAIN://join/abc123', 'abc123'],
    ['abc123.', 'abc123'],
    ['abc123,', 'abc123'],
    ['  abc123  ', 'abc123']
  ])('parses %s as %s', async (pasted, invite) => {
    const { ctx, rooms } = ctxWith()
    await roomHandlers(ctx)['room.pair']({ invite: pasted })
    expect(rooms.pair).toHaveBeenCalledWith(invite)
  })

  it('refuses an empty paste', () => {
    const { ctx, rooms } = ctxWith()
    expect(() => roomHandlers(ctx)['room.pair']({ invite: 'lightchain://  ' })).toThrow(
      /paste an invite/
    )
    expect(rooms.pair).not.toHaveBeenCalled()
  })
})

describe('room.leave', () => {
  it('forgets the attachment store along with the room', async () => {
    const { ctx, rooms } = ctxWith()
    const reply = await roomHandlers(ctx)['room.leave']({ room: ROOM })

    expect(rooms.leave).toHaveBeenCalledWith(ROOM)
    expect(ctx.forgetAttachments).toHaveBeenCalledWith(ROOM)
    expect(reply).toEqual({ left: true })
  })
})

describe('typing, receipts, presence, and reachability', () => {
  it('publishes typing only for an explicit true', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    handlers['room.typing']({ room: ROOM, typing: true })
    handlers['room.typing']({ room: ROOM, typing: 1 })

    expect(rooms.setTyping).toHaveBeenNthCalledWith(1, ROOM, true)
    expect(rooms.setTyping).toHaveBeenNthCalledWith(2, ROOM, false)
  })

  it('clears the read mark when no id is given', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    expect(handlers['room.setRead']({ room: ROOM })).toBeNull()
    expect(rooms.setRead).toHaveBeenCalledWith(ROOM, null)
  })

  it('switches receipts on only for an explicit yes', () => {
    const { ctx, rooms } = ctxWith()
    const handlers = roomHandlers(ctx)

    handlers['room.setReceipts']({ enabled: true })
    handlers['room.setReceipts']({ enabled: 'yes' })

    expect(rooms.setReceipts).toHaveBeenNthCalledWith(1, true)
    expect(rooms.setReceipts).toHaveBeenNthCalledWith(2, false)
  })

  it('answers presence with the machine-wide connection count attached', async () => {
    const { ctx } = ctxWith()
    const presence = await roomHandlers(ctx)['room.presence']({ room: ROOM })

    expect(presence).toEqual({ peers: ['peer-a'], connections: 3 })
  })

  it('answers net.status with the DHT key a blind peer must trust', async () => {
    const { ctx } = ctxWith({
      rooms: { states: vi.fn(async () => [{ key: ROOM }, { key: 'bb'.repeat(32) }]) }
    })

    const status = await roomHandlers(ctx)['net.status']()

    expect(status).toEqual({
      connections: 3,
      rooms: 2,
      dhtKey: ID.encode(DHT_KEY)
    })
  })
})

describe('room.invite and room.lodgingFailures', () => {
  it('returns the invite and the same invite as something clickable', async () => {
    const { ctx } = ctxWith()
    const reply = await roomHandlers(ctx)['room.invite']({ room: ROOM })

    expect(reply).toEqual({ invite: 'invite-string', link: 'lightchain://invite-string' })
  })

  it('surfaces rooms that failed to lodge, key and reason only', async () => {
    const { ctx } = ctxWith({
      rooms: {
        lodgingFailures: [
          { key: ROOM, reason: 'no blind peer answered', extra: 'not for the window' }
        ]
      }
    })

    expect(roomHandlers(ctx)['room.lodgingFailures']()).toEqual([
      { key: ROOM, reason: 'no blind peer answered' }
    ])
  })
})
