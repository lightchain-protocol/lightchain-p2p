import { describe, expect, it } from 'vitest'
import {
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MESSAGE_VERSION,
  MessageError,
  compareMessages,
  isValidEntry,
  orderMessages,
  parseEntry,
  roomName,
  type ChatMessage
} from './index.js'

const KEY = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

const message = (over: Partial<ChatMessage> = {}) => ({
  type: 'message',
  v: MESSAGE_VERSION,
  id: 'msg-00000001',
  from: KEY,
  at: 1_700_000_000_000,
  text: 'hello',
  ...over
})

describe('parsing messages', () => {
  it('accepts a well-formed message', () => {
    expect(parseEntry(message())).toMatchObject({ type: 'message', text: 'hello', from: KEY })
  })

  it('ignores unknown fields so a newer client does not break an older one', () => {
    const parsed = parseEntry({ ...message(), reactionsAddedIn2027: ['thumbsup'] })
    expect(parsed).not.toHaveProperty('reactionsAddedIn2027')
    expect((parsed as ChatMessage).text).toBe('hello')
  })

  it('carries replyTo when present and omits it when not', () => {
    expect(parseEntry(message({ replyTo: 'msg-00000000' }))).toHaveProperty('replyTo')
    expect(parseEntry(message())).not.toHaveProperty('replyTo')
  })

  it('refuses an entry from the future', () => {
    expect(() => parseEntry(message({ v: MESSAGE_VERSION + 1 }))).toThrow(/newer than this build/)
  })

  it('rejects malformed authors, ids and timestamps', () => {
    expect(() => parseEntry(message({ from: 'nope' }))).toThrow(/32-byte lowercase hex/)
    expect(() => parseEntry(message({ id: 'x' }))).toThrow(/8 to 64/)
    expect(() => parseEntry(message({ at: -1 }))).toThrow(/non-negative/)
    expect(() => parseEntry(message({ at: 1.5 }))).toThrow(/non-negative/)
  })

  it('bounds message length', () => {
    expect(() => parseEntry(message({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }))).toThrow(/exceeds/)
    expect(() => parseEntry(message({ text: 'x'.repeat(MAX_TEXT_LENGTH) }))).not.toThrow()
  })

  it('rejects rather than repairs, so nothing is rendered that its author did not write', () => {
    for (const bad of [null, 'string', 42, [], { type: 'message' }, { type: 'wat', v: 1 }]) {
      expect(() => parseEntry(bad), JSON.stringify(bad)).toThrow(MessageError)
    }
  })

  it('isValidEntry filters without throwing', () => {
    expect([message(), { nonsense: true }].filter(isValidEntry)).toHaveLength(1)
  })
})

describe('parsing add-writer', () => {
  it('accepts a writer key with an optional name', () => {
    expect(parseEntry({ type: 'add-writer', v: 1, key: OTHER })).toEqual({
      type: 'add-writer',
      v: 1,
      key: OTHER
    })
    expect(parseEntry({ type: 'add-writer', v: 1, key: OTHER, name: 'ada' })).toHaveProperty(
      'name',
      'ada'
    )
  })

  it('rejects a malformed writer key', () => {
    // Adding the wrong key grants write access to nobody and looks like the
    // join silently failed.
    expect(() => parseEntry({ type: 'add-writer', v: 1, key: '0x123' })).toThrow(/hex/)
  })
})

describe('room events', () => {
  const renamed = (name: string, over: Partial<ChatMessage> = {}) =>
    message({ text: `named the room “${name}”`, event: { kind: 'renamed', name }, ...over })

  it('carries a rename and omits the field when absent', () => {
    expect(parseEntry(renamed('Design'))).toHaveProperty('event.name', 'Design')
    expect(parseEntry(message())).not.toHaveProperty('event')
  })

  it('refuses an event it cannot describe rather than rendering it blindly', () => {
    expect(() => parseEntry(message({ event: { kind: 'exploded' } } as never))).toThrow(
      MessageError
    )
  })

  it('refuses a name longer than the limit', () => {
    expect(() => parseEntry(renamed('x'.repeat(MAX_NAME_LENGTH + 1)))).toThrow(/64 characters/)
  })

  it('takes the last name written, by the same order everything else uses', () => {
    // Two peers renaming without seeing each other must still agree afterwards.
    const first = parseEntry(renamed('First', { id: 'msg-00000001', at: 10 })) as ChatMessage
    const second = parseEntry(renamed('Second', { id: 'msg-00000002', at: 20 })) as ChatMessage

    expect(roomName([first, second])).toBe('Second')
    expect(roomName([second, first])).toBe('Second')
  })

  it('breaks a tied clock the same way on every peer', () => {
    const a = parseEntry(renamed('Ay', { id: 'msg-0000000a', at: 10 })) as ChatMessage
    const b = parseEntry(renamed('Bee', { id: 'msg-0000000b', at: 10 })) as ChatMessage

    expect(roomName([a, b])).toBe('Bee')
    expect(roomName([b, a])).toBe('Bee')
  })

  it('has no name when nobody set one, or when it was cleared', () => {
    expect(roomName([parseEntry(message()) as ChatMessage])).toBeNull()
    expect(roomName([parseEntry(renamed('')) as ChatMessage])).toBeNull()
  })
})

describe('display order', () => {
  it('sorts by the author clock', () => {
    const early = parseEntry(message({ id: 'aaaaaaaa', at: 1000 })) as ChatMessage
    const late = parseEntry(message({ id: 'bbbbbbbb', at: 2000 })) as ChatMessage
    expect(compareMessages(early, late)).toBeLessThan(0)
  })

  it('breaks ties on id, so the order is total', () => {
    // Without a tiebreak, two messages sharing a millisecond can render in
    // different orders on different machines, which reads as message loss.
    const a = parseEntry(message({ id: 'aaaaaaaa', at: 1000 })) as ChatMessage
    const b = parseEntry(message({ id: 'bbbbbbbb', at: 1000 })) as ChatMessage
    expect(compareMessages(a, b)).toBeLessThan(0)
    expect(compareMessages(b, a)).toBeGreaterThan(0)
    expect(compareMessages(a, a)).toBe(0)
  })

  it('produces the same order regardless of arrival order', () => {
    // The property that matters. Autobase can undo and reapply its view on a
    // fork, so entries genuinely do arrive in different orders on different
    // peers, and the rendering must not depend on that.
    const msgs = [
      parseEntry(message({ id: 'cccccccc', at: 3000 })),
      parseEntry(message({ id: 'aaaaaaaa', at: 1000 })),
      parseEntry(message({ id: 'bbbbbbbb', at: 2000 }))
    ] as ChatMessage[]

    const forward = orderMessages(msgs).map((m) => m.id)
    const reversed = orderMessages([...msgs].reverse()).map((m) => m.id)
    const shuffled = orderMessages([msgs[1]!, msgs[2]!, msgs[0]!]).map((m) => m.id)

    expect(forward).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
    expect(reversed).toEqual(forward)
    expect(shuffled).toEqual(forward)
  })

  it('drops duplicates by id, since reapply can deliver the same entry twice', () => {
    const one = parseEntry(message({ id: 'aaaaaaaa' })) as ChatMessage
    expect(orderMessages([one, one, one])).toHaveLength(1)
  })
})
