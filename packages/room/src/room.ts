import Autobase from 'autobase'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import type Corestore from 'corestore'
import type { HypercoreLike } from 'corestore'
import {
  MESSAGE_VERSION,
  isValidEntry,
  orderMessages,
  parseEntry,
  type ChatMessage
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

    const base = new Autobase<View>(opts.store.namespace(opts.namespace ?? 'room'), bootstrap, {
      open(store) {
        // The view needs its own encoding. It defaults to binary, and appending
        // an object to a binary core throws from inside apply, which surfaces
        // as the room failing to open rather than as an encoding mistake.
        return store.get({ name: 'view', valueEncoding: 'json' }) as View
      },
      async apply(nodes, view, host) {
        for (const node of nodes) {
          // Auto-ack appends null nodes to help indexers converge. Skipping
          // anything unparseable also means a malformed entry cannot wedge
          // apply, which would stop the room for everyone.
          if (!isValidEntry(node.value)) continue
          const entry = parseEntry(node.value)

          if (entry.type === 'add-writer') {
            await host.addWriter(b4a.from(entry.key, 'hex'), { indexer: true })
            continue
          }

          await view.append(entry)
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

  async send(text: string): Promise<ChatMessage> {
    if (!this.writable) {
      throw new RoomError(
        'not a writer in this room yet. An existing writer must add this peer\u2019s writerKey first.'
      )
    }

    const message: ChatMessage = {
      type: 'message',
      v: MESSAGE_VERSION,
      id: b4a.toString(crypto.randomBytes(12), 'hex'),
      from: this.writerKey,
      at: Date.now(),
      text
    }

    await this.#base.append(message)
    return message
  }

  /** Grants write access to another peer, by their `writerKey`. */
  async addWriter(writerKey: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(writerKey)) {
      throw new RoomError(`writer key must be 32 bytes of lowercase hex, got "${writerKey}"`)
    }
    if (!this.writable) {
      throw new RoomError('only an existing writer can add another')
    }
    await this.#base.append({ type: 'add-writer', v: MESSAGE_VERSION, key: writerKey })
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
