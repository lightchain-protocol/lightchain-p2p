import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_REACTION_LENGTH,
  MESSAGE_VERSION,
  entryAction,
  parseEntry,
  resolveRoom,
  type ChatMessage,
  type RoomEvent
} from './index.js'

const KEY = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ALICE = '0x' + '11'.repeat(20)
const BOB = '0x' + '22'.repeat(20)

let clock = 1_700_000_000_000
let counter = 0

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'message',
  v: MESSAGE_VERSION,
  id: `msg-${String(++counter).padStart(8, '0')}`,
  from: KEY,
  at: ++clock,
  text: 'hello',
  ...over
})

const event = (kind: RoomEvent, over: Partial<ChatMessage> = {}) =>
  message({ text: 'something happened', event: kind, ...over })

/** Proof, as the host supplies it: the claim is taken as checked. */
const proven = (m: ChatMessage) => m.author ?? null

const blob = { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 12 }
const attachment = (over: Record<string, unknown> = {}) => ({
  name: 'notes.txt',
  size: 12,
  type: 'text/plain',
  hash: '0x' + 'ab'.repeat(32),
  core: OTHER,
  blob,
  ...over
})

describe('deciding what goes into the view', () => {
  // The property this whole design turns on. `apply` must reach the same
  // verdict on the same bytes in every build that will ever exist, because two
  // peers appending different things fork a log that is already signed.
  it('appends an entry it cannot understand, so a newer peer cannot fork an older one', () => {
    expect(entryAction({ type: 'message', event: { kind: 'invented-in-2028' } })).toEqual({
      do: 'append'
    })
    expect(entryAction({ type: 'entirely-new-entry-type' })).toEqual({ do: 'append' })
    expect(entryAction({ type: 'message', v: 99 })).toEqual({ do: 'append' })
  })

  it('skips what is not an entry at all, including the nulls auto-ack writes', () => {
    expect(entryAction(null)).toEqual({ do: 'skip' })
    expect(entryAction(undefined)).toEqual({ do: 'skip' })
    expect(entryAction('a string')).toEqual({ do: 'skip' })
    expect(entryAction([])).toEqual({ do: 'skip' })
    expect(entryAction({ noType: true })).toEqual({ do: 'skip' })
  })

  it('singles out the two commands Autobase has to act on', () => {
    expect(entryAction({ type: 'add-writer', key: KEY })).toEqual({ do: 'add-writer', key: KEY })
    expect(entryAction({ type: 'remove-writer', key: KEY })).toEqual({
      do: 'remove-writer',
      key: KEY
    })
  })

  it('skips a writer command with an unusable key rather than wedging apply', () => {
    expect(entryAction({ type: 'add-writer', key: 'nope' })).toEqual({ do: 'skip' })
    expect(entryAction({ type: 'remove-writer' })).toEqual({ do: 'skip' })
  })
})

describe('parsing the new events', () => {
  it('drops an event kind it has never heard of and keeps the message', () => {
    // The other half of not forking: an old build has to survive reading what a
    // new build wrote, and the sentence is written to stand alone for exactly
    // this moment.
    const parsed = parseEntry(
      message({ text: 'reacted to a message', event: { kind: 'invented' } as never })
    )
    expect(parsed).toMatchObject({ type: 'message', text: 'reacted to a message' })
    expect(parsed).not.toHaveProperty('event')
  })

  it('still rejects a known event carrying wrong data', () => {
    expect(() => parseEntry(event({ kind: 'reacted', target: 'x', emoji: 'y' }))).toThrow(
      /name the message/
    )
    expect(() => parseEntry(event({ kind: 'renamed' } as never))).toThrow(/carry a name/)
    expect(() => parseEntry(event({ kind: 'removed', writer: 'nope' }))).toThrow(/hex writer key/)
  })

  it('bounds a reaction so it cannot be a sentence wearing a button', () => {
    const target = 'msg-00000001'
    expect(() =>
      parseEntry(event({ kind: 'reacted', target, emoji: 'x'.repeat(MAX_REACTION_LENGTH + 1) }))
    ).toThrow(/may not exceed/)
    expect(() => parseEntry(event({ kind: 'reacted', target, emoji: '👨‍👩‍👧‍👦' }))).not.toThrow()
  })

  it('bounds a self-chosen name', () => {
    expect(() =>
      parseEntry(event({ kind: 'named-self', name: 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }))
    ).toThrow(/may not exceed/)
  })

  it('treats an absent withdrawal and an explicit false as the same thing', () => {
    const target = 'msg-00000001'
    const without = parseEntry(event({ kind: 'reacted', target, emoji: 'y' })) as ChatMessage
    const explicit = parseEntry(
      event({ kind: 'reacted', target, emoji: 'y', removed: false })
    ) as ChatMessage
    expect(without.event).toEqual(explicit.event)
    expect(without.event).not.toHaveProperty('removed')
  })

  it('accepts a remove-writer command', () => {
    expect(parseEntry({ type: 'remove-writer', v: MESSAGE_VERSION, key: KEY })).toEqual({
      type: 'remove-writer',
      v: MESSAGE_VERSION,
      key: KEY
    })
  })
})

describe('parsing an attachment', () => {
  it('accepts a well-formed one', () => {
    expect(parseEntry(message({ attachment: attachment() }))).toHaveProperty('attachment')
  })

  it('refuses one bigger than every member is willing to hold', () => {
    expect(() =>
      parseEntry(message({ attachment: attachment({ size: MAX_ATTACHMENT_SIZE + 1 }) }))
    ).toThrow(/exceeds/)
  })

  it('refuses a name long enough to be a path of its own', () => {
    expect(() =>
      parseEntry(
        message({
          attachment: attachment({ name: 'x'.repeat(MAX_ATTACHMENT_NAME_LENGTH + 1) })
        })
      )
    ).toThrow(/characters/)
  })

  it('refuses a malformed hash, core or blob address', () => {
    expect(() => parseEntry(message({ attachment: attachment({ hash: '0xdead' }) }))).toThrow(
      /32 bytes of hex/
    )
    expect(() => parseEntry(message({ attachment: attachment({ core: 'nope' }) }))).toThrow(
      /hex key/
    )
    expect(() =>
      parseEntry(message({ attachment: attachment({ blob: { ...blob, byteLength: -1 } }) }))
    ).toThrow(/non-negative/)
  })
})

describe('resolving a conversation', () => {
  it('applies an edit by its own author', () => {
    const original = message({ text: 'frist', author: ALICE, sig: '0x' + '1'.repeat(130) })
    const edit = event({ kind: 'edited', target: original.id }, { text: 'first', author: ALICE })

    const room = resolveRoom([original, edit], { authorOf: proven })

    expect(room.messages).toHaveLength(1)
    expect(room.messages[0]?.text).toBe('first')
    expect(room.messages[0]?.editedAt).toBe(edit.at)
  })

  it('refuses an edit from somebody else, and keeps it visible rather than swallowing it', () => {
    // The attack this exists to stop: anyone in a room could otherwise put
    // words in anyone's mouth. Refusing quietly would be worse than refusing
    // loudly, so the attempt stays in the conversation where it can be seen.
    const original = message({ text: 'what alice said', author: ALICE })
    const forged = event(
      { kind: 'edited', target: original.id },
      { text: 'what bob wants', author: BOB }
    )

    const room = resolveRoom([original, forged], { authorOf: proven })

    expect(room.messages.map((m) => m.text)).toEqual(['what alice said', 'what bob wants'])
    expect(room.messages[0]?.editedAt).toBeUndefined()
  })

  it('honours nothing at all when the caller cannot prove authorship', () => {
    // The default. A resolver that trusted the `author` field would hand every
    // member the ability to rewrite every message.
    const original = message({ text: 'original', author: ALICE })
    const edit = event(
      { kind: 'edited', target: original.id },
      { text: 'rewritten', author: ALICE }
    )

    const room = resolveRoom([original, edit])

    expect(room.messages[0]?.text).toBe('original')
  })

  it('takes the last edit when there are several', () => {
    const original = message({ text: 'one', author: ALICE })
    const first = event({ kind: 'edited', target: original.id }, { text: 'two', author: ALICE })
    const second = event({ kind: 'edited', target: original.id }, { text: 'three', author: ALICE })

    const room = resolveRoom([original, second, first], { authorOf: proven })

    expect(room.messages[0]?.text).toBe('three')
  })

  it('lets a withdrawal beat a rewrite, whichever order they arrive in', () => {
    const original = message({ text: 'regrettable', author: ALICE })
    const edit = event({ kind: 'edited', target: original.id }, { text: 'less so', author: ALICE })
    const gone = event({ kind: 'deleted', target: original.id }, { author: ALICE })

    for (const order of [
      [original, edit, gone],
      [original, gone, edit]
    ]) {
      const room = resolveRoom(order, { authorOf: proven })
      expect(room.messages[0]?.text).toBe('')
      expect(room.messages[0]?.deletedAt).toBe(gone.at)
    }
  })

  it('gathers reactions and drops those taken back', () => {
    const target = message({ text: 'a thing', author: ALICE })
    const up = event({ kind: 'reacted', target: target.id, emoji: '👍' }, { author: ALICE })
    const alsoUp = event({ kind: 'reacted', target: target.id, emoji: '👍' }, { author: BOB })
    const down = event({ kind: 'reacted', target: target.id, emoji: '👎' }, { author: BOB })
    const undone = event(
      { kind: 'reacted', target: target.id, emoji: '👎', removed: true },
      { author: BOB }
    )

    const room = resolveRoom([target, up, alsoUp, down, undone], { authorOf: proven })

    expect(room.messages).toHaveLength(1)
    expect(room.messages[0]?.reactions).toEqual([{ emoji: '👍', by: [ALICE, BOB].sort() }])
  })

  it('lets one person react once, however many times they press it', () => {
    const target = message({ text: 'a thing', author: ALICE })
    const once = event({ kind: 'reacted', target: target.id, emoji: '👍' }, { author: ALICE })
    const again = event({ kind: 'reacted', target: target.id, emoji: '👍' }, { author: ALICE })

    const room = resolveRoom([target, once, again], { authorOf: proven })

    expect(room.messages[0]?.reactions?.[0]?.by).toEqual([ALICE])
  })

  it('keeps an event whose target has not arrived, so nothing written is lost', () => {
    const orphan = event(
      { kind: 'edited', target: 'msg-99999999' },
      { text: 'to nothing', author: ALICE }
    )

    const room = resolveRoom([orphan], { authorOf: proven })

    expect(room.messages.map((m) => m.text)).toEqual(['to nothing'])
  })

  it('records a name only for somebody who proved who they are', () => {
    const named = event({ kind: 'named-self', name: 'Alice' }, { author: ALICE })
    const unproven = event({ kind: 'named-self', name: 'Definitely Bob' })

    const room = resolveRoom([named, unproven], { authorOf: proven })

    expect(room.names.get(ALICE)).toBe('Alice')
    expect(room.names.size).toBe(1)
  })

  it('clears a name when it is set to nothing', () => {
    const named = event({ kind: 'named-self', name: 'Alice' }, { author: ALICE })
    const cleared = event({ kind: 'named-self', name: '  ' }, { author: ALICE })

    expect(resolveRoom([named, cleared], { authorOf: proven }).names.size).toBe(0)
  })

  it('pins and unpins, and anyone in the room may do it', () => {
    const target = message({ text: 'worth keeping', author: ALICE })
    const pin = event({ kind: 'pinned', target: target.id }, { author: BOB })

    const pinned = resolveRoom([target, pin], { authorOf: proven })
    expect(pinned.pinned).toEqual([target.id])
    expect(pinned.messages[0]?.pinned).toBe(true)

    const unpin = event({ kind: 'pinned', target: target.id, removed: true }, { author: BOB })
    expect(resolveRoom([target, pin, unpin], { authorOf: proven }).pinned).toEqual([])
  })

  it('folds message-level events away and keeps room-level ones', () => {
    const target = message({ text: 'said', author: ALICE })
    const reaction = event({ kind: 'reacted', target: target.id, emoji: '👍' }, { author: ALICE })
    const renamed = event({ kind: 'renamed', name: 'Design' }, { text: 'named the room Design' })

    const room = resolveRoom([target, reaction, renamed], { authorOf: proven })

    expect(room.messages.map((m) => m.text)).toEqual(['said', 'named the room Design'])
    expect(room.name).toBe('Design')
  })

  it('resolves the same way whatever order the entries arrive in', () => {
    // Two peers holding the same set must show the same room, or the same
    // conversation reads differently depending on the network.
    const target = message({ text: 'one', author: ALICE })
    const edit = event({ kind: 'edited', target: target.id }, { text: 'two', author: ALICE })
    const react = event({ kind: 'reacted', target: target.id, emoji: '👍' }, { author: BOB })
    const named = event({ kind: 'named-self', name: 'Alice' }, { author: ALICE })

    const forwards = resolveRoom([target, edit, react, named], { authorOf: proven })
    const backwards = resolveRoom([named, react, edit, target], { authorOf: proven })

    expect(JSON.stringify(forwards.messages)).toBe(JSON.stringify(backwards.messages))
    expect([...forwards.names]).toEqual([...backwards.names])
  })
})
