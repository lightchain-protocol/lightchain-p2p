import Autobase from 'autobase'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import type Corestore from 'corestore'
import type { HypercoreLike } from 'corestore'
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_REACTION_LENGTH,
  MAX_TEXT_LENGTH,
  MESSAGE_VERSION,
  authorPreimage,
  entryAction,
  isValidEntry,
  orderMessages,
  parseEntry,
  roomName,
  type Attachment,
  type ChatMessage,
  type ModelAnswer
} from '@lcai-p2p/protocol'

/**
 * A multi-writer chat room.
 *
 * Several people write, everyone converges on the same set of messages, and it
 * keeps working when whoever created the room is offline — which is the whole
 * reason for Autobase rather than broadcasting over a swarm topic. The official
 * part-one tutorial broadcasts and keeps no history; this does not.
 *
 * ## Order comes from the messages, not from Autobase
 *
 * Autobase's view is **not stable until signed**: on a fork it is undone and
 * reapplied, so an entry's position can change after it has been read. Reading
 * therefore collects entries and sorts them with the protocol's own comparison,
 * which is deterministic across peers. See `@lcai-p2p/protocol`.
 *
 * ## Writers are added from inside apply
 *
 * `addWriter` exists on the host passed to `apply`, not on the base. A joiner
 * cannot add itself: an existing writer appends a command, and every peer's
 * apply performs the same change, so the writer set converges like everything
 * else.
 */

export class RoomError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoomError'
  }
}

interface View extends HypercoreLike {
  readonly length: number
}

/** What can travel alongside a message. */
export interface SendOptions {
  /** The `id` of the message being replied to. */
  readonly replyTo?: string
  /**
   * A file, already written to the room's blob store.
   *
   * The reference only. The bytes are put in place first, because a message
   * pointing at a blob that was never written is a broken attachment that every
   * member keeps forever.
   */
  readonly attachment?: Attachment
}

export interface RoomOptions {
  readonly store: Corestore
  /** Omit to create a room; supply a room key to join one. */
  readonly key?: string
  /**
   * Corestore namespace holding this room's writer core. Rooms sharing a store
   * must each be given their own.
   *
   * Two rooms on one namespace share a local writer core, which does not fail
   * loudly — it deadlocks. And because the namespace determines which writer
   * core a room reopens onto, it must be **stable across restarts**: derive it
   * from the room key or another durable identifier, never randomly per open,
   * or the peer gets a new identity each launch and silently loses the write
   * access it was granted.
   */
  readonly namespace?: string
  /**
   * The room's encryption key, as hex.
   *
   * Omit when creating and one is generated. **Required to open a room someone
   * else created**, and travels with the room key in a pairing confirmation
   * rather than separately.
   */
  readonly encryptionKey?: string
}

/**
 * A wallet, reduced to what a room needs from one.
 *
 * An interface rather than the `Wallet` class, so this package keeps no
 * dependency on a curve or on the wallet's storage. Reading a room needs
 * neither.
 */
export interface Identity {
  readonly address: string
  sign(preimage: string): string
  hashText(text: string): string
}

export class Room {
  readonly #base: Autobase<View>

  private constructor(base: Autobase<View>) {
    this.#base = base
  }

  static async open(opts: RoomOptions): Promise<Room> {
    let bootstrap: Uint8Array | null = null
    if (opts.key !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(opts.key)) {
        throw new RoomError(`room key must be 32 bytes of lowercase hex, got "${opts.key}"`)
      }
      bootstrap = b4a.from(opts.key, 'hex')
    }

    let encryptionKey: Uint8Array | null = null
    if (opts.encryptionKey !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(opts.encryptionKey)) {
        throw new RoomError('encryption key must be 32 bytes of lowercase hex')
      }
      encryptionKey = b4a.from(opts.encryptionKey, 'hex')
    }

    const base = new Autobase<View>(opts.store.namespace(opts.namespace ?? 'room'), bootstrap, {
      // Without this the room is readable by anyone holding its key, including
      // the blind peers we rely on to keep it available.
      encrypt: true,
      encryptionKey,
      open(store) {
        // The view needs its own encoding. It defaults to binary, and appending
        // an object to a binary core throws from inside apply, which surfaces
        // as the room failing to open rather than as an encoding mistake.
        return store.get({ name: 'view', valueEncoding: 'json' }) as View
      },
      async apply(nodes, view, host) {
        for (const node of nodes) {
          // Every decision here comes from entryAction, which is deliberately
          // ignorant: it looks at the shape of an entry and never at whether
          // this build can make sense of it. The view is a Hypercore that
          // indexers sign and every peer must agree on byte for byte, so a
          // decision that depended on how much this build understood would fork
          // the room the first time two peers were on different versions.
          //
          // That has been got wrong twice in different ways. Appending the
          // parsed entry made the view the parser's *output*. Gating on whether
          // the entry parsed made the view depend on the parser's *verdict*.
          // Both fork, and a forked room cannot be repaired because the entries
          // are already signed.
          const action = entryAction(node.value)

          if (action.do === 'skip') continue

          if (action.do === 'add-writer') {
            await host.addWriter(b4a.from(action.key, 'hex'), { indexer: true })
            continue
          }

          if (action.do === 'remove-writer') {
            // Autobase refuses to remove the last indexer, and asking anyway
            // throws in here, which would wedge apply for everybody. Checking
            // first turns "the room stops working" into "that removal did
            // nothing", and the entry stays in the log either way.
            const key = b4a.from(action.key, 'hex')
            if (host.removeable(key)) await host.removeWriter(key)
            continue
          }

          await view.append(node.value)
        }
      },
      valueEncoding: 'json'
    })

    await base.ready()
    return new Room(base)
  }

  /** The room key. This is what someone needs to join. */
  get key(): string {
    return b4a.toString(this.#base.key, 'hex')
  }

  /**
   * The key that decrypts this room, as hex.
   *
   * Needed alongside the room key to open it. Both are handed over together in
   * a pairing confirmation, so a room key on its own is not enough to read
   * anything.
   */
  get encryptionKey(): string {
    const key = this.#base.encryptionKey
    if (!key) throw new RoomError('room opened without encryption')
    return b4a.toString(key, 'hex')
  }

  /** Swarm topic for this room. */
  get discoveryKey(): Buffer {
    return this.#base.discoveryKey
  }

  /**
   * This peer's writer key.
   *
   * A joiner sends this to an existing writer, who adds it. It is not the room
   * key, and confusing the two produces a join that appears to succeed and
   * never grants write access.
   */
  get writerKey(): string {
    return b4a.toString(this.#base.local.key, 'hex')
  }

  get writable(): boolean {
    return this.#base.writable
  }

  /**
   * Signs outgoing messages with the wallet, when one is attached.
   *
   * Optional, because a room works without a wallet and messages written before
   * this existed have no author. Attaching one means every message this peer
   * writes from now on carries a provable identity; it does nothing
   * retroactively, and it cannot.
   */
  #identity: Identity | null = null

  useIdentity(identity: Identity | null): void {
    this.#identity = identity
  }

  /**
   * Attaches the wallet's claim to a message, when one is attached.
   *
   * The preimage covers the id, writer, clock and a hash of the text, so the
   * signature is over this message in this room and cannot be lifted into
   * another. Everything written here goes through it — a path that forgot to
   * would produce entries that look unattributed rather than ones that fail.
   */
  #sign(message: ChatMessage): ChatMessage {
    if (!this.#identity) return message
    const identity = this.#identity

    return {
      ...message,
      author: identity.address,
      sig: identity.sign(authorPreimage(this.key, message, (t) => identity.hashText(t)))
    }
  }

  /**
   * Refuses text the readers would throw away.
   *
   * `parseEntry` rejects anything past the limit, and every reader — including
   * this one — skips what will not parse. Appending it anyway produced the
   * worst of both: the send reported success, the block was written into a log
   * that can never be compacted, and the message then existed nowhere. Failing
   * here is the only outcome the person typing can act on.
   */
  #checkLength(text: string): void {
    if (text.length > MAX_TEXT_LENGTH) {
      throw new RoomError(
        `a message may not exceed ${MAX_TEXT_LENGTH} characters, and this one is ${text.length}`
      )
    }
  }

  /**
   * Signs one message and appends it.
   *
   * Every write goes through here. A path that built its own entry would sooner
   * or later forget the signature, and an unsigned entry is not rejected — it
   * is shown as unattributed, which looks like an older peer rather than like a
   * bug.
   */
  async #write(
    fields: Omit<ChatMessage, 'type' | 'v' | 'id' | 'from' | 'at'>
  ): Promise<ChatMessage> {
    if (!this.writable) {
      throw new RoomError(
        'not a writer in this room yet. An existing writer must add this peer\u2019s writerKey first.'
      )
    }
    this.#checkLength(fields.text)

    const signed = this.#sign({
      type: 'message',
      v: MESSAGE_VERSION,
      id: b4a.toString(crypto.randomBytes(12), 'hex'),
      from: this.writerKey,
      at: Date.now(),
      ...fields
    })

    await this.#base.append(signed)
    return signed
  }

  async send(text: string, options: SendOptions = {}): Promise<ChatMessage> {
    return this.#write({
      text,
      ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      ...(options.attachment === undefined ? {} : { attachment: options.attachment })
    })
  }

  /**
   * Adds a reaction, or takes one back.
   *
   * One entry per press. There is nowhere to keep a counter that every peer
   * would agree on without writing down how it got there, so the log records
   * the presses and the reader adds them up — last press wins, per person, per
   * message, per reaction.
   */
  async react(target: string, emoji: string, on = true): Promise<ChatMessage> {
    if (emoji.trim() === '') throw new RoomError('a reaction needs a reaction')
    if (emoji.length > MAX_REACTION_LENGTH) {
      throw new RoomError(`a reaction may not exceed ${MAX_REACTION_LENGTH} characters`)
    }

    return this.#write({
      text: on ? `reacted with ${emoji}` : `took back a ${emoji}`,
      event: { kind: 'reacted', target, emoji, ...(on ? {} : { removed: true }) }
    })
  }

  /**
   * Rewrites one of your own messages.
   *
   * The replacement is this entry's text, and the event only says which message
   * it replaces. Nothing here can stop somebody writing an edit against another
   * person's message — anyone can append anything to their own core — so the
   * check that matters happens when the room is read, where a signature can be
   * tested. See `resolveRoom` in the protocol package.
   */
  async edit(target: string, text: string): Promise<ChatMessage> {
    return this.#write({ text, event: { kind: 'edited', target } })
  }

  /**
   * Withdraws one of your own messages.
   *
   * Withdrawn, not erased, and the difference is not a quibble: the original
   * entry is signed and has already been replicated to everybody in the room.
   * This asks every reader to stop showing it. Readers that understand the
   * request comply, readers that predate it carry on, and anybody who kept a
   * copy keeps it. An interface must not describe this as deleting.
   */
  async deleteMessage(target: string): Promise<ChatMessage> {
    return this.#write({ text: 'withdrew a message', event: { kind: 'deleted', target } })
  }

  /** Pins a message to the room, or unpins it. Anyone who can write may do either. */
  async pin(target: string, on = true): Promise<ChatMessage> {
    return this.#write({
      text: on ? 'pinned a message' : 'unpinned a message',
      event: { kind: 'pinned', target, ...(on ? {} : { removed: true }) }
    })
  }

  /**
   * Says what you would like to be called here.
   *
   * About yourself and nobody else. A name others could set is a way to relabel
   * a person as somebody they are not, and only the address underneath has been
   * proven. An empty name clears it.
   */
  async nameSelf(name: string): Promise<ChatMessage> {
    const trimmed = name.trim()
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new RoomError(`a name may not exceed ${MAX_DISPLAY_NAME_LENGTH} characters`)
    }

    return this.#write({
      text: trimmed === '' ? 'cleared their name' : `is now known as ${trimmed}`,
      event: { kind: 'named-self', name: trimmed }
    })
  }

  /**
   * Posts a model's answer into the room, with everything needed to check it.
   *
   * Signed by the relayer as well, so there are two separate claims: this
   * person put it here, and that worker said it. The second is the one that
   * matters, and it does not depend on trusting the first.
   */
  async relay(text: string, answer: ModelAnswer): Promise<ChatMessage> {
    if (!this.writable) {
      throw new RoomError('not a writer in this room yet')
    }
    this.#checkLength(text)

    const signed = this.#sign({
      type: 'message',
      v: MESSAGE_VERSION,
      id: b4a.toString(crypto.randomBytes(12), 'hex'),
      from: this.writerKey,
      at: Date.now(),
      text,
      answer
    })

    await this.#base.append(signed)
    return signed
  }

  /**
   * Names the room, for everyone in it.
   *
   * Written as an ordinary message carrying a rename event, so a client that
   * predates this shows a sentence saying what happened rather than skipping
   * the entry. The sentence is the message; the structured name beside it is
   * what a client that understands the event reads.
   */
  async rename(name: string): Promise<ChatMessage> {
    const trimmed = name.trim()
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new RoomError(`a room name may not exceed ${MAX_NAME_LENGTH} characters`)
    }
    if (!this.writable) throw new RoomError('only a writer can name a room')

    const message: ChatMessage = {
      type: 'message',
      v: MESSAGE_VERSION,
      id: b4a.toString(crypto.randomBytes(12), 'hex'),
      from: this.writerKey,
      at: Date.now(),
      text: trimmed === '' ? 'cleared the room name' : `named the room “${trimmed}”`,
      event: { kind: 'renamed', name: trimmed }
    }

    await this.#base.append(this.#sign(message))
    return message
  }

  /** The room's name, or null if nobody has set one. */
  async name(): Promise<string | null> {
    return roomName(await this.messages())
  }

  /**
   * The Autobase behind this room, for handing to a blind peer.
   *
   * Exposed reluctantly and narrowly: everything else here is deliberately
   * about rooms rather than about Autobase, and a caller that reaches through
   * this to write would bypass every check above it. It exists because
   * availability is arranged from outside — the host knows which blind peers to
   * use and the room does not.
   */
  get base(): unknown {
    return this.#base
  }

  /**
   * Grants write access to another peer, by their `writerKey`.
   *
   * Two entries: the command that changes the writer set, and a message saying
   * it happened. The command is consumed by `apply` and never reaches the view,
   * so without the second the room would gain a member with nothing to show for
   * it — people would simply start talking and nobody would know when they
   * arrived.
   */
  async addWriter(writerKey: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(writerKey)) {
      throw new RoomError(`writer key must be 32 bytes of lowercase hex, got "${writerKey}"`)
    }
    if (!this.writable) {
      throw new RoomError('only an existing writer can add another')
    }
    await this.#base.append({ type: 'add-writer', v: MESSAGE_VERSION, key: writerKey })

    await this.#write({
      text: `added ${writerKey.slice(0, 8)}… to the room`,
      event: { kind: 'joined', writer: writerKey }
    })
  }

  /**
   * Takes write access away from a peer.
   *
   * Any writer may do this, which is the trust model the room already has:
   * anyone who can write can add an accomplice, so a removal is not a power
   * they lacked before. It is not a moderation system and should not be sold as
   * one.
   *
   * It does not erase what they wrote. Their entries are signed and replicated
   * and stay in the history, which is honest — they did write them.
   *
   * Autobase refuses to remove the last indexer, so a room cannot be left with
   * nobody able to write. That refusal happens inside `apply`, where throwing
   * would stop the room for everybody, so `apply` checks first and the removal
   * simply does nothing. This is the one case where the command is written and
   * has no effect.
   */
  async removeWriter(writerKey: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(writerKey)) {
      throw new RoomError(`writer key must be 32 bytes of lowercase hex, got "${writerKey}"`)
    }
    if (!this.writable) {
      throw new RoomError('only a writer can remove another')
    }

    // The announcement goes first, which is the opposite of `addWriter` and
    // deliberate. Removing somebody can cost the remover their own access —
    // two people removing each other at the same moment is the obvious way,
    // and removing yourself is another — and once that has happened there is
    // no way to append the sentence explaining it. Writing it first means the
    // worst outcome is a room that says somebody was removed when they were
    // not, which somebody can read and correct, rather than a room where
    // access silently changed and nothing says why.
    //
    // Both appends are guarded, because `writable` can go false between the
    // check above and either write. Autobase reports that as "Not writable",
    // which tells the person who asked nothing at all about what happened.
    try {
      await this.#write({
        text: `removed ${writerKey.slice(0, 8)}… from the room`,
        event: { kind: 'removed', writer: writerKey }
      })
      await this.#base.append({ type: 'remove-writer', v: MESSAGE_VERSION, key: writerKey })
    } catch (err) {
      throw new RoomError(
        `the removal could not be written: ${(err as Error).message}. This peer may have lost write access while the request was in flight, which happens when two people remove each other at once.`
      )
    }
  }

  /**
   * Every message, in display order.
   *
   * Reads the whole view. Fine for the message volumes this currently handles
   * and honest about it: a room with a long history wants an indexed view
   * (HyperDB) rather than a linear scan, which is a change to `open` and to
   * this method only.
   */
  async messages(): Promise<ChatMessage[]> {
    await this.#base.update()

    const view = this.#base.view
    const found: ChatMessage[] = []

    for (let i = 0; i < view.length; i++) {
      const value = await view.get(i)
      if (!isValidEntry(value)) continue
      const entry = parseEntry(value)
      if (entry.type === 'message') found.push(entry)
    }

    return orderMessages(found)
  }

  async update(): Promise<void> {
    await this.#base.update()
  }

  /**
   * Runs `listener` whenever the view advances, from a local write or a peer.
   * Returns a function that unsubscribes.
   *
   * A caller that polls `messages()` instead shows remote messages a poll
   * interval late, which in a chat reads as the other person being slow.
   *
   * This is deliberately not an `EventEmitter`. The emitter is a different
   * module under Bare than under Node, and a subscription that hands back its
   * own removal is harder to leak than a pair of `on`/`off` calls that have to
   * agree on a function reference.
   */
  onUpdate(listener: () => void): () => void {
    this.#base.on('update', listener)
    return () => {
      this.#base.off('update', listener)
    }
  }

  /**
   * Replicates over a connection.
   *
   * Uses the base rather than the store so the wakeup protocol is attached,
   * which is how peers learn about active writers.
   */
  replicate(socket: unknown): void {
    this.#base.replicate(socket)
  }

  async close(): Promise<void> {
    await this.#base.close()
  }
}
