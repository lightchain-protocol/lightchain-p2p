/**
 * The attack the v2 preimage exists to stop.
 *
 * v1 signed the id, the writer, the clock and a hash of the text. It did not
 * sign `event`, and an `edited` or `deleted` event names the message it acts
 * on. So a signature that proved "Alice wrote an edit" did not prove *which
 * message she was editing*, and anybody could move it.
 *
 * The room's authorisation was never the weak part: it correctly insisted that
 * only a proven author may rewrite their own message. It was asking a signature
 * a question the signature did not answer.
 */

import { describe, expect, it } from 'vitest'
import {
  MESSAGE_VERSION,
  authorPreimage,
  resolveRoom,
  verifyAuthor,
  type ChatMessage
} from './index.js'

const ROOM = 'a'.repeat(64)
const OTHER_ROOM = 'b'.repeat(64)
const WRITER = 'c'.repeat(64)
const ALICE = '0x' + '11'.repeat(20)
const MALLORY = '0x' + '22'.repeat(20)

/** A hash with no cryptography in it, but a real dependence on every byte. */
const hashText = (text: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `0x${hash.toString(16).padStart(64, '0')}`
}

/**
 * A signature scheme with the right shape and a real check.
 *
 * The signature is the signer's address followed by the preimage's own hash, so
 * `recover` can only return that address when the preimage it is handed is the
 * one that was signed. That is the whole property under test: change anything
 * the preimage covers and recovery yields a different answer.
 */
const signAs = (address: string) => (preimage: string) =>
  `0x${address.slice(2).toLowerCase()}${hashText(preimage).slice(2)}`.padEnd(132, '0').slice(0, 132)

const recover = (preimage: string, signature: string) => {
  const claimed = `0x${signature.slice(2, 42)}`
  const covered = signature.slice(42, 106)
  if (covered !== hashText(preimage).slice(2, 66)) return '0x' + 'ff'.repeat(20)
  return claimed
}

let counter = 0
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'message',
  v: MESSAGE_VERSION,
  id: `msg-${String(++counter).padStart(8, '0')}`,
  from: WRITER,
  at: 1_700_000_000_000 + counter,
  text: 'something',
  ...over
})

/** Signs an entry the way a wallet does, at whichever preimage version. */
const signed = (entry: ChatMessage, address: string, version: 1 | 2 = 2): ChatMessage => ({
  ...entry,
  author: address,
  sig: signAs(address)(authorPreimage(ROOM, entry, hashText, version))
})

const proven = (m: ChatMessage) => {
  try {
    return verifyAuthor(ROOM, m, recover, hashText)
  } catch {
    return null
  }
}

describe('moving a signed edit onto another message', () => {
  it('is refused, because the target is now signed', () => {
    const first = signed(message({ text: 'the one alice meant to fix' }), ALICE)
    const second = signed(message({ text: 'the one she did not' }), ALICE)

    const edit = signed(
      message({ text: 'corrected', event: { kind: 'edited', target: first.id } }),
      ALICE
    )

    // Mallory takes Alice's signed edit verbatim and repoints it.
    const rebound: ChatMessage = {
      ...edit,
      event: { kind: 'edited', target: second.id }
    }

    expect(proven(edit)).toBe(ALICE)
    expect(proven(rebound)).toBeNull()

    const room = resolveRoom([first, second, rebound], { authorOf: proven })
    expect(room.messages.find((m) => m.id === second.id)?.text).toBe('the one she did not')
  })

  it('is refused for a withdrawal too', () => {
    const keep = signed(message({ text: 'worth keeping' }), ALICE)
    const regret = signed(message({ text: 'not worth keeping' }), ALICE)

    const withdrawal = signed(
      message({ text: 'withdrew a message', event: { kind: 'deleted', target: regret.id } }),
      ALICE
    )

    const rebound: ChatMessage = {
      ...withdrawal,
      event: { kind: 'deleted', target: keep.id }
    }

    const room = resolveRoom([keep, regret, rebound], { authorOf: proven })
    expect(room.messages.find((m) => m.id === keep.id)?.deletedAt).toBeUndefined()
  })

  it('cannot be laundered by presenting an old-style signature instead', () => {
    // The fallback that keeps existing plain messages attributed must not become
    // a way to sign an event-bearing entry under the rules that never covered
    // events. This is the mistake that would quietly reopen the whole thing.
    const target = signed(message({ text: 'alice said this' }), ALICE)
    const edit = signed(
      message({ text: 'rewritten', event: { kind: 'edited', target: target.id } }),
      ALICE,
      1
    )

    expect(proven(edit)).toBeNull()
  })
})

describe('what a v2 signature covers', () => {
  const cases: [string, Partial<ChatMessage>, Partial<ChatMessage>][] = [
    ['the reply it answers', { replyTo: 'msg-00000001' }, { replyTo: 'msg-00000002' }],
    [
      'the reaction and its target',
      { event: { kind: 'reacted', target: 'msg-00000001', emoji: '👍' } },
      { event: { kind: 'reacted', target: 'msg-00000001', emoji: '👎' } }
    ],
    [
      'the name somebody claims',
      { event: { kind: 'named-self', name: 'Alice' } },
      { event: { kind: 'named-self', name: 'Mallory' } }
    ],
    [
      'the writer a removal names',
      { event: { kind: 'removed', writer: 'd'.repeat(64) } },
      { event: { kind: 'removed', writer: 'e'.repeat(64) } }
    ],
    [
      'the file it points at',
      {
        attachment: {
          name: 'a.png',
          size: 1,
          type: 'image/png',
          hash: '0x' + 'aa'.repeat(32),
          core: 'd'.repeat(64),
          blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
        }
      },
      {
        attachment: {
          name: 'a.png',
          size: 1,
          type: 'image/png',
          hash: '0x' + 'bb'.repeat(32),
          core: 'd'.repeat(64),
          blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
        }
      }
    ]
  ]

  for (const [what, original, tampered] of cases) {
    it(`covers ${what}`, () => {
      const entry = signed(message(original), ALICE)
      expect(proven(entry)).toBe(ALICE)
      expect(proven({ ...entry, ...tampered })).toBeNull()
    })
  }

  it('covers a relayed answer, which v1 never did either', () => {
    const answer = {
      model: 'llama3-8b',
      jobId: '1',
      sessionId: '2',
      worker: '0x' + '33'.repeat(20),
      ciphertext: 'AAAA',
      sessionKey: '0x' + '44'.repeat(32),
      signature: '0x' + '55'.repeat(65)
    }
    const entry = signed(message({ answer }), ALICE)

    expect(proven(entry)).toBe(ALICE)
    expect(proven({ ...entry, answer: { ...answer, jobId: '9' } })).toBeNull()
  })

  it('is still bound to its room', () => {
    const entry = signed(message({ event: { kind: 'pinned', target: 'msg-00000001' } }), ALICE)
    expect(() => verifyAuthor(OTHER_ROOM, entry, recover, hashText)).toThrow(/does not hold/)
  })

  it('does not depend on the order the entry was built in', () => {
    // Canonicalisation is the reason a signature survives an object being
    // assembled differently. Without it the same entry signs two ways.
    const base = message({ event: { kind: 'reacted', target: 'msg-00000001', emoji: '👍' } })
    const reordered = {
      event: base.event,
      text: base.text,
      at: base.at,
      from: base.from,
      id: base.id,
      v: base.v,
      type: base.type
    } as ChatMessage

    expect(authorPreimage(ROOM, base, hashText)).toBe(authorPreimage(ROOM, reordered, hashText))
  })
})

describe('what an old signature is still good for', () => {
  it('a plain message keeps its v1 attribution', () => {
    // These are already in logs and cannot be re-signed. A v1 signature covers
    // everything a plain message contains, so nothing is being taken on trust.
    const entry = signed(message({ text: 'written before any of this' }), ALICE, 1)
    expect(proven(entry)).toBe(ALICE)
  })

  it('and its text is still covered', () => {
    const entry = signed(message({ text: 'as written' }), ALICE, 1)
    expect(proven({ ...entry, text: 'as rewritten' })).toBeNull()
  })

  it('a forged author fails at both versions', () => {
    const entry = message({ text: 'not mine to claim' })
    const forged: ChatMessage = {
      ...entry,
      author: ALICE,
      sig: signAs(MALLORY)(authorPreimage(ROOM, entry, hashText))
    }
    expect(proven(forged)).toBeNull()
  })
})
