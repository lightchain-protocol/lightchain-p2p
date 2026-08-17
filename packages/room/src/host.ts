import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import type Corestore from 'corestore'
import type { ChatMessage } from '@lcai-p2p/protocol'
import { Room, RoomError } from './room.js'

/**
 * Every room a client is in, over one store and one swarm.
 *
 * This is the part that a chat application actually talks to: `Room` handles one
 * conversation, and the awkward problems — keeping several apart in shared
 * storage, coming back after a restart as the same writer, telling a view that
 * something changed — belong to the collection rather than to any one room.
 *
 * It does no I/O of its own beyond the store. Persistence is injected as a
 * {@link RoomRegistry} so the same code runs under Bare in the application and
 * under Node in tests, where a restart can be simulated without touching a disk.
 */

/** What has to be remembered about a room to reopen it as the same writer. */
export interface RoomRecord {
  readonly key: string
  readonly namespace: string
}

export interface RoomRegistry {
  read(): readonly RoomRecord[]
  write(records: readonly RoomRecord[]): void
}

/** Everything a view needs to render one room. */
export interface RoomState {
  readonly key: string
  /**
   * What this peer hands to an existing writer to be let in. Not the room key —
   * sending that instead produces a join that appears to work and never grants
   * write access.
   */
  readonly writerKey: string
  readonly writable: boolean
  readonly messages: readonly ChatMessage[]
}

/** The part of a Hyperswarm topic session a host uses. */
export interface DiscoveryLike {
  /** Resolves once the topic has been announced to the DHT. */
  flushed(): Promise<void>
  refresh(opts?: { client?: boolean; server?: boolean }): Promise<void>
}

/** The part of Hyperswarm a host uses. Narrow so tests can substitute it. */
export interface SwarmLike {
  readonly connections: Iterable<unknown>
  on(event: 'connection', fn: (socket: unknown) => void): unknown
  join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): DiscoveryLike
  leave(topic: Uint8Array): unknown
}

export interface RoomHostOptions {
  readonly store: Corestore
  readonly swarm: SwarmLike
  /** Omit and rooms are forgotten on restart. */
  readonly registry?: RoomRegistry
  /** Called after a room changes, coalesced. */
  readonly onChange?: (state: RoomState) => void
  /** Coalescing window in milliseconds. */
  readonly settle?: number
  /**
   * How long to wait for a room's topic to be announced before returning it
   * anyway. Zero disables the wait.
   */
  readonly announceTimeout?: number
  /** Delays, in milliseconds, at which to look the topic up again. */
  readonly rediscoverAfter?: readonly number[]
}

/** A room that could not be reopened, and why. */
export interface FailedRoom {
  readonly key: string
  readonly reason: string
}

interface Entry {
  readonly room: Room
  readonly namespace: string
  discovery: DiscoveryLike | null
  unsubscribe: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
  rediscover: ReturnType<typeof setTimeout>[]
}

/**
 * When to look a topic up again after joining it.
 *
 * Hyperswarm looks a topic up once on join and then not again for ten minutes.
 * Two peers joining at nearly the same moment is therefore a race: if the
 * joiner's lookup runs before the creator's announce has propagated, it finds
 * nobody and the room stays silent for ten minutes, which reads as the feature
 * being broken rather than slow. These retries cover the window in which the
 * announce is still spreading; after them, Hyperswarm's own refresh takes over.
 */
const REDISCOVER_AFTER = [3_000, 8_000, 20_000, 45_000]

/** A registry that forgets, for tests and for callers that do not want persistence. */
export function memoryRegistry(initial: readonly RoomRecord[] = []): RoomRegistry {
  let records = [...initial]
  return {
    read: () => records,
    write: (next) => {
      records = [...next]
    }
  }
}

function randomNamespace(): string {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

export class RoomHost {
  readonly #store: Corestore
  readonly #swarm: SwarmLike
  readonly #registry: RoomRegistry | null
  readonly #onChange: ((state: RoomState) => void) | null
  readonly #settle: number
  readonly #announceTimeout: number
  readonly #rediscoverAfter: readonly number[]
  readonly #rooms = new Map<string, Entry>()
  /**
   * Records that would not open. Kept so that saving the registry does not
   * discard them: a room dropped from the list because of a failure that turns
   * out to be transient is a conversation the user silently loses.
   */
  readonly #unopened: RoomRecord[] = []

  /** Rooms in the registry that would not reopen. Empty on a healthy start. */
  readonly failed: FailedRoom[] = []

  private constructor(opts: RoomHostOptions) {
    this.#store = opts.store
    this.#swarm = opts.swarm
    this.#registry = opts.registry ?? null
    this.#onChange = opts.onChange ?? null
    this.#settle = opts.settle ?? 50
    this.#announceTimeout = opts.announceTimeout ?? 10_000
    this.#rediscoverAfter = opts.rediscoverAfter ?? REDISCOVER_AFTER
  }

  static async open(opts: RoomHostOptions): Promise<RoomHost> {
    const host = new RoomHost(opts)

    opts.swarm.on('connection', (socket) => {
      for (const { room } of host.#rooms.values()) room.replicate(socket)
    })

    for (const record of opts.registry?.read() ?? []) {
      try {
        await host.#open(record)
      } catch (err) {
        // One unreadable room must not stop the others from opening. The
        // alternative is an application that will not start because of a
        // conversation the user may not even remember joining.
        host.#unopened.push(record)
        host.failed.push({ key: record.key, reason: (err as Error).message })
      }
    }

    // Opening a room saves as it goes, so a record that fails after a
    // successful one has already been written out of the registry by the time
    // it is known about. Only on the unhappy path: a clean start should not
    // rewrite the file it just read.
    if (host.#unopened.length > 0) host.#save()

    return host
  }

  get keys(): string[] {
    return [...this.#rooms.keys()]
  }

  async create(): Promise<RoomState> {
    // Random because the namespace determines the key: reusing one reopens the
    // existing room instead of making a new one.
    const room = await this.#open({ namespace: randomNamespace() })
    return this.#stateOf(await this.#announced(room))
  }

  async join(key: string): Promise<RoomState> {
    const trimmed = key.trim()
    // The room key is a stable, durable identifier, which is exactly what the
    // namespace has to be for write access to survive a restart.
    const room = await this.#open({ key: trimmed, namespace: trimmed })
    return this.#stateOf(await this.#announced(room))
  }

  async send(key: string, text: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.send(text)
    return this.#stateOf(room)
  }

  async invite(key: string, writerKey: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.addWriter(writerKey.trim())
    return this.#stateOf(room)
  }

  async leave(key: string): Promise<boolean> {
    const entry = this.#rooms.get(key)
    if (!entry) return false

    this.#rooms.delete(key)
    entry.unsubscribe?.()
    if (entry.timer) clearTimeout(entry.timer)
    for (const timer of entry.rediscover) clearTimeout(timer)
    this.#swarm.leave(entry.room.discoveryKey)
    await entry.room.close()
    this.#save()
    return true
  }

  async state(key: string): Promise<RoomState> {
    return this.#stateOf(this.#require(key))
  }

  async states(): Promise<RoomState[]> {
    return Promise.all([...this.#rooms.values()].map(({ room }) => this.#stateOf(room)))
  }

  async close(): Promise<void> {
    const entries = [...this.#rooms.values()]
    this.#rooms.clear()
    for (const entry of entries) {
      entry.unsubscribe?.()
      if (entry.timer) clearTimeout(entry.timer)
      for (const timer of entry.rediscover) clearTimeout(timer)
      await entry.room.close().catch(() => undefined)
    }
  }

  #require(key: string): Room {
    const entry = this.#rooms.get(key)
    if (!entry) throw new RoomError(`not in room ${String(key).slice(0, 8)}`)
    return entry.room
  }

  async #stateOf(room: Room): Promise<RoomState> {
    return {
      key: room.key,
      writerKey: room.writerKey,
      writable: room.writable,
      messages: await room.messages()
    }
  }

  async #open(record: { key?: string; namespace: string }): Promise<Room> {
    const room = await Room.open({
      store: this.#store,
      key: record.key,
      namespace: record.namespace
    })

    // A create only learns its key here, and a duplicate record would otherwise
    // open the same room twice over one namespace, which deadlocks.
    const existing = this.#rooms.get(room.key)
    if (existing) {
      await room.close()
      return existing.room
    }

    const entry: Entry = {
      room,
      namespace: record.namespace,
      discovery: null,
      unsubscribe: null,
      timer: null,
      rediscover: []
    }
    entry.unsubscribe = room.onUpdate(() => this.#schedule(room.key))
    this.#rooms.set(room.key, entry)

    // Connections made before this room existed are not covered by the handler
    // installed in `open`.
    for (const socket of this.#swarm.connections) room.replicate(socket)
    entry.discovery = this.#swarm.join(room.discoveryKey, { server: true, client: true })

    for (const delay of this.#rediscoverAfter) {
      const timer = setTimeout(() => {
        entry.discovery?.refresh({ client: true }).catch(() => undefined)
      }, delay)
      timer.unref?.()
      entry.rediscover.push(timer)
    }

    this.#save()
    return room
  }

  /**
   * Waits for the room's topic to reach the DHT.
   *
   * Returning a room key before it is announced hands the user something to
   * share that nobody can resolve yet. Bounded, because an unreachable network
   * should make joining slow rather than make the application hang.
   */
  async #announced(room: Room): Promise<Room> {
    const discovery = this.#rooms.get(room.key)?.discovery
    if (!discovery || this.#announceTimeout <= 0) return room

    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      discovery.flushed().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.#announceTimeout)
        timer.unref?.()
      })
    ])
    clearTimeout(timer)
    return room
  }

  /**
   * Coalesces a burst of updates into one notification.
   *
   * Autobase emits per advance, so catching up on a peer's history emits many in
   * a row. Reading the whole view for each would do quadratic work to produce
   * frames nobody sees.
   */
  #schedule(key: string): void {
    const entry = this.#rooms.get(key)
    if (!entry || entry.timer || !this.#onChange) return

    entry.timer = setTimeout(() => {
      entry.timer = null
      if (!this.#rooms.has(key)) return
      void this.#stateOf(entry.room).then(
        (state) => this.#onChange?.(state),
        () => undefined
      )
    }, this.#settle)

    // Nothing should be kept alive merely because a room is being watched.
    entry.timer.unref?.()
  }

  #save(): void {
    this.#registry?.write([
      ...[...this.#rooms.values()].map(({ room, namespace }) => ({ key: room.key, namespace })),
      ...this.#unopened
    ])
  }
}
