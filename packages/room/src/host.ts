import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import z32 from 'z32'
import Autobase from 'autobase'
import BlindPairing from 'blind-pairing'
import type Corestore from 'corestore'
import {
  resolveRoom,
  verifyAuthor,
  type ChatMessage,
  type ModelAnswer,
  type ResolvedMessage
} from '@lcai-p2p/protocol'
import { Presence, type PresenceState } from './presence.js'
import { Room, RoomError, type Identity, type SendOptions } from './room.js'

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

/**
 * What has to be remembered about a room to reopen it as the same writer.
 *
 * **This includes a secret.** `encryptionKey` decrypts the room, so wherever a
 * registry is persisted is as sensitive as the room itself. Encryption keeps a
 * room from the peers replicating it — blind peers especially — and does
 * nothing against someone reading this machine's storage, where the key sits
 * beside the data it protects.
 */
export interface RoomRecord {
  readonly key: string
  readonly namespace: string
  readonly encryptionKey: string
}

export interface RoomRegistry {
  read(): readonly RoomRecord[]
  write(records: readonly RoomRecord[]): void
}

/**
 * A message with this peer's judgement of who wrote it.
 *
 * `verified` is a local conclusion, not something that travels — it is absent
 * on the wire and absent here when no author was claimed. Kept separate from
 * `ChatMessage` so nothing can accidentally append a claim of its own
 * verification.
 */
export interface AttributedMessage extends ChatMessage {
  readonly verified?: boolean
  /**
   * Whether a relayed model answer holds up: the worker signed this ciphertext,
   * and it decrypts to exactly the text shown. Absent when the message is not
   * an answer.
   */
  readonly answered?: boolean
}

/**
 * Somewhere that will hold a room while nobody is online.
 *
 * An interface rather than `BlindRegistry`, so this package does not depend on
 * blind peering to open a room — a peer with no availability configured must
 * still work, and most will not have any.
 */
export interface RoomAvailability {
  registerAutobase(base: unknown, opts?: { announce?: boolean }): Promise<void>
}

/**
 * What a host needs to check an author claim, if it is to check them at all.
 *
 * Declared as function-typed properties rather than as methods, because that is
 * how they are used: `verifyAuthor` is handed `recover` and `hashText` on their
 * own, detached from whatever object supplied them. A method declaration would
 * say they may rely on a `this` that is not going to be there.
 */
export interface AuthorChecks {
  recover: (preimage: string, signature: string) => string
  hashText: (text: string) => string
  /** Checks a relayed model answer. Omit and answers are shown unproven. */
  answer?: (answer: ModelAnswer, text: string) => boolean
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
  /**
   * What the room is called, agreed by every member, or null if nobody has
   * named it. Derived from the log rather than stored locally, so a name set on
   * one machine is the name everyone sees.
   */
  readonly name: string | null
  /**
   * Every entry, as written, with this peer's verdict on who wrote each.
   *
   * The log rather than the conversation: edits appear as separate messages,
   * withdrawn text is still here, and reactions are individual entries. Use
   * {@link conversation} to show a room; use this to inspect one.
   */
  readonly messages: readonly AttributedMessage[]
  /**
   * The same room, with its events applied — the thing to render.
   *
   * Edits have replaced the text they rewrote, withdrawn messages are empty
   * and carry `deletedAt`, reactions are gathered onto the messages they
   * belong to, and the entries that did all of that are gone, because showing
   * "reacted with a thumbs up" beside the thumbs up says it twice.
   */
  readonly conversation: readonly ResolvedAttributedMessage[]
  /**
   * What people have chosen to be called, by proven address.
   *
   * Only covers members whose signature checked out, because a name attached to
   * an unproven identity is two claims where the first one has already failed.
   * An address missing here has no name, and the address is what to show.
   */
  readonly names: Readonly<Record<string, string>>
  /** Ids of pinned messages, in display order. */
  readonly pinned: readonly string[]
}

/** A resolved message that also carries this peer's verdict on its author. */
export interface ResolvedAttributedMessage extends ResolvedMessage {
  readonly verified?: boolean
  readonly answered?: boolean
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
  /** How long `pair` waits for a host to answer an invite. */
  readonly pairTimeout?: number
  /**
   * How long to wait for a room's topic to be announced before returning it
   * anyway. Zero disables the wait.
   */
  readonly announceTimeout?: number
  /** Delays, in milliseconds, at which to look the topic up again. */
  readonly rediscoverAfter?: readonly number[]
  /**
   * Where to lodge rooms so they outlive everyone being offline.
   *
   * Without this a room replicates only while some participant is running, so
   * two people who are never online at the same time never exchange anything.
   * The peer holds ciphertext and cannot read the room.
   */
  readonly availability?: RoomAvailability
  /**
   * How to check who wrote a message. Omit and messages are passed through
   * unattributed, which is what a peer without a wallet should do.
   */
  readonly verify?: AuthorChecks
  /** Called when the peers or typers in a room change. Nothing is persisted. */
  readonly onPresence?: (key: string, state: PresenceState) => void
  /**
   * Publish read receipts in every room.
   *
   * Off unless set, because a receipt tells other people when you read what
   * they wrote and nobody agreed to that by opening a chat. Changed later
   * through {@link RoomHost.setReceipts}.
   */
  readonly receipts?: boolean
}

/** A room that could not be reopened, and why. */
export interface FailedRoom {
  readonly key: string
  readonly reason: string
}

interface Entry {
  readonly room: Room
  readonly namespace: string
  /** Typing, peer count, roster and receipts. Nothing here is written anywhere. */
  readonly presence: Presence
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

/**
 * What the joiner sent with their request.
 *
 * Rejected rather than trusted: accepting a candidate grants write access to
 * the room, so a malformed or hostile payload must not reach `addWriter`.
 */
function readJoiner(userData: Uint8Array): { writerKey: string } | null {
  try {
    const parsed: unknown = JSON.parse(b4a.toString(userData))
    const writerKey = (parsed as { writerKey?: unknown })?.writerKey
    if (typeof writerKey !== 'string' || !/^[0-9a-f]{64}$/.test(writerKey)) return null
    return { writerKey }
  } catch {
    return null
  }
}

export class RoomHost {
  readonly #store: Corestore
  readonly #swarm: SwarmLike
  readonly #registry: RoomRegistry | null
  readonly #onChange: ((state: RoomState) => void) | null
  readonly #settle: number
  readonly #announceTimeout: number
  readonly #rediscoverAfter: readonly number[]
  readonly #pairTimeout: number
  readonly #verify: AuthorChecks | null
  readonly #availability: RoomAvailability | null
  readonly #onPresence: ((key: string, state: PresenceState) => void) | null
  /** Not readonly: a person can change their mind about receipts mid-session. */
  #receipts: boolean
  #identity: Identity | null = null
  #pairing: BlindPairing | null = null
  #reattach: ReturnType<typeof setInterval> | null = null
  /** Room key to the member serving its invite. */
  readonly #members = new Map<string, { close(): Promise<void> }>()
  readonly #rooms = new Map<string, Entry>()
  /**
   * Records that would not open. Kept so that saving the registry does not
   * discard them: a room dropped from the list because of a failure that turns
   * out to be transient is a conversation the user silently loses.
   */
  readonly #unopened: RoomRecord[] = []

  /** Rooms in the registry that would not reopen. Empty on a healthy start. */
  readonly failed: FailedRoom[] = []

  /**
   * Rooms that could not be lodged with a blind peer.
   *
   * Kept rather than thrown, because failing to arrange availability is not a
   * reason to refuse a room — but it is a reason the room will vanish when
   * everyone closes the app, and nothing else would say so.
   */
  readonly lodgingFailures: FailedRoom[] = []

  private constructor(opts: RoomHostOptions) {
    this.#store = opts.store
    this.#swarm = opts.swarm
    this.#registry = opts.registry ?? null
    this.#onChange = opts.onChange ?? null
    this.#verify = opts.verify ?? null
    this.#availability = opts.availability ?? null
    this.#onPresence = opts.onPresence ?? null
    this.#receipts = opts.receipts === true
    this.#settle = opts.settle ?? 50
    this.#announceTimeout = opts.announceTimeout ?? 10_000
    this.#rediscoverAfter = opts.rediscoverAfter ?? REDISCOVER_AFTER
    this.#pairTimeout = opts.pairTimeout ?? 60_000
  }

  static async open(opts: RoomHostOptions): Promise<RoomHost> {
    const host = new RoomHost(opts)

    opts.swarm.on('connection', (socket) => {
      for (const entry of host.#rooms.values()) {
        entry.room.replicate(socket)
        entry.presence?.attach(socket)
      }
    })

    // Retrying the attach was tried and removed: over a real pairing the remote
    // rejected the channel every time — 57 opens, 57 closes, no handshake — so
    // a retry loop only churned channels. See presence.ts for what is and is
    // not established about this.

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

  /**
   * Opens rooms from records that were not available when the host started.
   *
   * A registry can be unreadable at boot — sealed under a key that does not
   * exist until a wallet is unlocked — which means the rooms cannot be opened
   * in the constructor. This is that second chance, and it skips whatever is
   * already open so calling it twice is harmless.
   *
   * Returns what could be opened. Failures land in `failed`, as at startup: one
   * unreadable room must not cost the others.
   */
  async reload(records: readonly RoomRecord[]): Promise<RoomState[]> {
    const opened: RoomState[] = []

    for (const record of records) {
      if (this.#rooms.has(record.key)) continue

      try {
        const room = await this.#open(record)
        opened.push(await this.#stateOf(room))
      } catch (err) {
        this.#unopened.push(record)
        this.failed.push({ key: record.key, reason: (err as Error).message })
      }
    }

    return opened
  }

  async create(): Promise<RoomState> {
    // Random because the namespace determines the key: reusing one reopens the
    // existing room instead of making a new one.
    const room = await this.#open({ namespace: randomNamespace() })
    return this.#stateOf(await this.#announced(room))
  }

  /**
   * Opens a room from its key and encryption key.
   *
   * Both are required, which is the point: a room key alone no longer reads
   * anything. {@link pair} is the normal path and carries both for you.
   */
  async join(key: string, encryptionKey: string): Promise<RoomState> {
    const trimmed = key.trim()
    // The room key is a stable, durable identifier, which is exactly what the
    // namespace has to be for write access to survive a restart.
    const room = await this.#open({
      key: trimmed,
      namespace: trimmed,
      encryptionKey: encryptionKey.trim()
    })
    return this.#stateOf(await this.#announced(room))
  }

  /**
   * An invite to a room, safe to send over anything.
   *
   * The alternative — handing someone the room key — gives permanent read
   * access to whoever sees the message, forever, with no way to take it back.
   * An invite is a capability that is spent once: it carries no room key, and
   * the key is only handed over inside the confirmation, after this side has
   * accepted the joiner and added them as a writer.
   *
   * The joiner's writer key travels in the same exchange, so the second
   * copy-and-paste step disappears with the first.
   *
   * **Spent once, and only while this peer is running.** The link is a bearer
   * token for write access, and it lands in places that keep a copy — a group
   * chat, a screenshot, a mail thread. Serving it more than once would mean
   * anybody who ever saw it could still be joining the room weeks later, so the
   * first joiner to complete the exchange closes it. Everyone after them is
   * told the invite has been used, which is the same thing they are told when
   * the host is offline, and the remedy is the same: ask for another.
   *
   * It is held in memory rather than written into the room, because putting it
   * in the room means a permanent entry type and any writer being able to
   * service it. Both are reasonable; neither is decided yet.
   */
  async invite(key: string): Promise<string> {
    const entry = this.#rooms.get(key)
    if (!entry) throw new RoomError(`not in room ${String(key).slice(0, 8)}`)
    if (!entry.room.writable) {
      throw new RoomError('only a writer can invite, because accepting one grants write access')
    }

    const roomKey = b4a.from(key, 'hex')
    const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(roomKey)

    // Replaces any earlier invite for this room, so a link that has been shared
    // around does not outlive the one the user is looking at.
    await this.#members
      .get(key)
      ?.close()
      .catch(() => undefined)

    // Claimed before the first await, so two candidates arriving together
    // cannot both pass the check and both be let in.
    let claimed = false

    const member = this.#blindPairing().addMember({
      discoveryKey,
      onadd: async (candidate) => {
        if (claimed) return
        claimed = true

        try {
          candidate.open(publicKey)

          const joiner = readJoiner(candidate.userData)
          if (!joiner) throw new RoomError('a candidate arrived without a writer key')

          await entry.room.addWriter(joiner.writerKey)

          // The encryption key travels with the room key, and only here.
          // Handing over one without the other would grant a peer that can
          // replicate the room and read none of it.
          candidate.confirm({
            key: roomKey,
            encryptionKey: b4a.from(entry.room.encryptionKey, 'hex')
          })
        } catch (err) {
          // Nobody got in, so the invite was not spent. Releasing it means a
          // candidate that failed on a bad writer key does not burn the link
          // the user is still looking at.
          claimed = false
          throw err
        }

        // The member is deliberately left open. Closing it here is what a
        // spent invite ought to look like, but the confirmation above has not
        // reached the joiner yet — tearing the exchange down at this point
        // loses it, and the person who was let in hangs until their own
        // timeout. Refusing to serve a second candidate is the property that
        // matters, and the flag above is what enforces it; the member is
        // released when a fresh invite replaces it or the host closes.
      }
    })

    await member.flushed()
    this.#members.set(key, member)

    return z32.encode(invite)
  }

  /**
   * Joins a room with an invite, arriving as a writer.
   *
   * The writer core is created before pairing so its key can be sent with the
   * request, and the namespace is generated here and recorded with the room —
   * which is what lets the same peer reopen as the same writer later.
   */
  async pair(invite: string): Promise<RoomState> {
    let decoded: Uint8Array
    try {
      decoded = z32.decode(invite.trim())
    } catch {
      throw new RoomError('that does not look like an invite')
    }

    const namespace = randomNamespace()
    const writerKey = b4a.toString(
      await Autobase.getLocalKey(this.#store.namespace(namespace)),
      'hex'
    )

    const session = this.#blindPairing().addCandidate({
      invite: decoded,
      userData: b4a.from(JSON.stringify({ writerKey }))
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      session.pairing,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.#pairTimeout)
        timer.unref?.()
      })
    ])
    clearTimeout(timer)
    await session.close().catch(() => undefined)

    if (!result) {
      // The connection count is reported rather than diagnosed. Zero can mean
      // the sender is offline or that something local is blocking this machine,
      // and the two are genuinely hard to tell apart from here — but a person
      // who is told they have reached nobody at all will check their own
      // machine, which the old message actively discouraged by blaming the
      // sender. Having reached someone rules that half out.
      throw new RoomError(
        this.connections === 0
          ? 'nobody answered that invite, and this machine has not connected to any peer at all. Either the sender is offline, or something here is blocking connections - a firewall that was never allowed is the usual cause, and gives no other sign.'
          : 'nobody answered that invite. It may have been used already, or the person who sent it may be offline.'
      )
    }

    if (!result.encryptionKey) {
      throw new RoomError(
        'that invite came from a peer that did not send an encryption key, so the room cannot be read'
      )
    }

    const room = await this.#open({
      key: b4a.toString(result.key, 'hex'),
      namespace,
      encryptionKey: b4a.toString(result.encryptionKey, 'hex')
    })
    await this.#announced(room)

    // The confirmation says the host accepted; it does not mean their
    // add-writer entry has reached us yet. Waiting makes `pair` mean "you can
    // write", so a caller does not have to poll to find out whether the thing
    // it just awaited actually worked.
    await this.#writable(room)

    return this.#stateOf(room)
  }

  /** Waits, bounded, for a granted write to arrive over replication. */
  async #writable(room: Room): Promise<void> {
    const deadline = Date.now() + this.#pairTimeout
    while (!room.writable && Date.now() < deadline) {
      await room.update()
      if (room.writable) return
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100)
        timer.unref?.()
      })
    }
  }

  #blindPairing(): BlindPairing {
    if (!this.#pairing) this.#pairing = new BlindPairing(this.#swarm)
    return this.#pairing
  }

  async send(key: string, text: string, options: SendOptions = {}): Promise<RoomState> {
    const room = this.#require(key)
    await room.send(text, options)
    return this.#stateOf(room)
  }

  /** Adds a reaction to a message, or takes one back. */
  async react(key: string, target: string, emoji: string, on = true): Promise<RoomState> {
    const room = this.#require(key)
    await room.react(target, emoji, on)
    return this.#stateOf(room)
  }

  /** Rewrites one of this peer's own messages. Refused on read if it is not. */
  async edit(key: string, target: string, text: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.edit(target, text)
    return this.#stateOf(room)
  }

  /** Withdraws one of this peer's own messages. Does not erase it; nothing can. */
  async deleteMessage(key: string, target: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.deleteMessage(target)
    return this.#stateOf(room)
  }

  /** Pins a message to the room, or unpins it. */
  async pin(key: string, target: string, on = true): Promise<RoomState> {
    const room = this.#require(key)
    await room.pin(target, on)
    return this.#stateOf(room)
  }

  /** Says what this peer would like to be called in a room. */
  async nameSelf(key: string, name: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.nameSelf(name)
    return this.#stateOf(room)
  }

  /**
   * Says whether this peer is typing in a room.
   *
   * Goes over the presence channel, which stores nothing anywhere. Calling it
   * on every keystroke is fine — repeats of the current state send no bytes.
   */
  setTyping(key: string, typing: boolean): void {
    const entry = this.#rooms.get(key)
    if (!entry) return
    entry.presence.setTyping(typing)
    if (typing) entry.presence.refresh()
  }

  /**
   * Says how far this peer has read in a room.
   *
   * Recorded whether or not receipts are on, and only published when they are,
   * so that switching them on has something to say. Like typing, it goes over
   * the presence channel and is written nowhere.
   */
  setRead(key: string, messageId: string | null): void {
    this.#rooms.get(key)?.presence.setRead(messageId)
  }

  /**
   * Publishes read receipts, or stops, in every room at once.
   *
   * One switch rather than one per room: it is a decision about what this
   * person is prepared to publish about themselves, not about any particular
   * conversation. Rooms opened afterwards inherit it.
   */
  setReceipts(enabled: boolean): void {
    this.#receipts = enabled
    for (const entry of this.#rooms.values()) entry.presence.setReceipts(enabled)
  }

  presenceOf(key: string): PresenceState {
    return this.#rooms.get(key)?.presence.state ?? { peers: 0, typing: 0, roster: [] }
  }

  /**
   * How many peers this machine is connected to, across every topic.
   *
   * Zero while rooms are open and a topic has been announced is the signature
   * of being blocked locally rather than of nobody being there — reaching the
   * DHT is outbound and works through almost anything, while accepting or
   * completing a connection is not.
   */
  get connections(): number {
    return [...this.#swarm.connections].length
  }

  /** Names a room, for everyone in it. */
  async rename(key: string, name: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.rename(name)
    return this.#stateOf(room)
  }

  /** Posts a model's answer into a room, with the evidence that it said it. */
  async relay(key: string, text: string, answer: ModelAnswer): Promise<RoomState> {
    const room = this.#require(key)
    await room.relay(text, answer)
    return this.#stateOf(room)
  }

  /**
   * Grants write access to a peer whose writer key you already have.
   *
   * The manual path. {@link invite} is the one to reach for: it carries the
   * writer key itself, so nobody has to move a second string by hand. This
   * remains for a peer that joined read-only with a room key.
   */
  async addWriter(key: string, writerKey: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.addWriter(writerKey.trim())
    return this.#stateOf(room)
  }

  /**
   * Takes write access away from a peer.
   *
   * Any writer may do this, because any writer can already add an accomplice.
   * It is not moderation and must not be presented as though it were.
   */
  async removeWriter(key: string, writerKey: string): Promise<RoomState> {
    const room = this.#require(key)
    await room.removeWriter(writerKey.trim())
    return this.#stateOf(room)
  }

  async leave(key: string): Promise<boolean> {
    const entry = this.#rooms.get(key)
    if (!entry) return false

    this.#rooms.delete(key)
    entry.unsubscribe?.()
    entry.presence.close()
    if (entry.timer) clearTimeout(entry.timer)
    for (const timer of entry.rediscover) clearTimeout(timer)
    this.#swarm.leave(entry.room.discoveryKey)
    await entry.room.close()
    this.#save()
    return true
  }

  /**
   * Both halves needed to open this room again elsewhere.
   *
   * Deliberately not part of {@link RoomState}, which crosses into the view:
   * the encryption key is a secret and the view has no use for one. Use this
   * for a backup, or to hand a room over by hand where an invite will not do.
   */
  credentials(key: string): { key: string; encryptionKey: string } {
    const room = this.#require(key)
    return { key: room.key, encryptionKey: room.encryptionKey }
  }

  async state(key: string): Promise<RoomState> {
    return this.#stateOf(this.#require(key))
  }

  async states(): Promise<RoomState[]> {
    return Promise.all([...this.#rooms.values()].map(({ room }) => this.#stateOf(room)))
  }

  async close(): Promise<void> {
    if (this.#reattach) clearInterval(this.#reattach)
    this.#reattach = null
    for (const member of this.#members.values()) await member.close().catch(() => undefined)
    this.#members.clear()
    await this.#pairing?.close().catch(() => undefined)
    this.#pairing = null

    const entries = [...this.#rooms.values()]
    this.#rooms.clear()
    for (const entry of entries) {
      entry.unsubscribe?.()
      entry.presence.close()
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

  /**
   * Attaches a wallet to every room, present and future.
   *
   * Rooms opened later pick it up too, which is what makes locking and
   * unlocking the wallet mid-session behave: one call, and everything this peer
   * writes is signed or stops being signed.
   */
  useIdentity(identity: Identity | null): void {
    this.#identity = identity
    for (const entry of this.#rooms.values()) {
      entry.room.useIdentity(identity)
      // The roster carries whatever address this peer claims, so unlocking a
      // wallet has to reach the people who are already connected rather than
      // only the ones who arrive afterwards.
      entry.presence.setAddress(identity?.address ?? null)
    }
  }

  async #stateOf(room: Room): Promise<RoomState> {
    const messages = await room.messages()
    const attributed = this.#verify
      ? messages.map((m) => this.#attribute(room.key, m))
      : (messages as AttributedMessage[])

    // Resolving happens here rather than in whatever is displaying the room.
    // Two clients that applied edits, withdrawals and reactions differently
    // would show different conversations to people who are in the same one, and
    // the rules are subtle enough — last write wins, per author, per emoji,
    // withdrawal beating rewrite — that nobody should be reimplementing them.
    //
    // Authorship comes from this host's own verification and nowhere else. A
    // message is only allowed to rewrite or withdraw another when its signature
    // checked out, so `verified` is the whole gate: without it, anybody in the
    // room could delete anybody's message by writing an address in a field.
    const resolved = resolveRoom(attributed, {
      authorOf: (message) =>
        (message as AttributedMessage).verified === true ? (message.author ?? null) : null
    })

    return {
      key: room.key,
      writerKey: room.writerKey,
      writable: room.writable,
      // From the same messages already in hand, rather than a second read.
      name: resolved.name,
      messages: attributed,
      conversation: resolved.messages,
      // A plain object because this crosses into the view as JSON, and a Map
      // arrives there as `{}`.
      names: Object.fromEntries(resolved.names),
      pinned: resolved.pinned
    }
  }

  /**
   * Decides who wrote a message, and says so on the message itself.
   *
   * A failed signature does not hide the message — someone is in the room
   * saying it, and pretending otherwise would be its own kind of lie. It is
   * marked as disputed, which the interface can render as loudly as it likes.
   */
  #attribute(roomKey: string, message: ChatMessage): AttributedMessage {
    if (!this.#verify) return message

    let attributed: AttributedMessage
    try {
      const author = verifyAuthor(roomKey, message, this.#verify.recover, this.#verify.hashText)
      attributed = author === null ? message : { ...message, verified: true }
    } catch {
      attributed = { ...message, verified: false }
    }

    // Who relayed it and what the model said are separate claims, and the
    // second does not depend on the first: a stranger can quote a model
    // provably.
    if (!message.answer) return attributed

    const answered = this.#verify.answer?.(message.answer, message.text) ?? false
    return { ...attributed, answered }
  }

  async #open(record: { key?: string; namespace: string; encryptionKey?: string }): Promise<Room> {
    const room = await Room.open({
      store: this.#store,
      key: record.key,
      namespace: record.namespace,
      encryptionKey: record.encryptionKey
    })

    room.useIdentity(this.#identity)

    // Lodged in the background. A blind peer that is slow or unreachable must
    // not hold up opening the room — the room works either way, it just does
    // not outlive its participants.
    if (this.#availability) {
      this.#availability
        .registerAutobase(room.base, { announce: true })
        .catch((err: Error) => this.lodgingFailures.push({ key: room.key, reason: err.message }))
    }

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
      presence: new Presence({
        topic: room.discoveryKey,
        onChange: (state) => this.#onPresence?.(room.key, state),
        writerKey: room.writerKey,
        address: this.#identity?.address ?? null,
        receipts: this.#receipts
      }),
      discovery: null,
      unsubscribe: null,
      timer: null,
      rediscover: []
    }
    entry.unsubscribe = room.onUpdate(() => this.#schedule(room.key))
    entry.presence.start()
    this.#rooms.set(room.key, entry)

    // Connections made before this room existed are not covered by the handler
    // installed in `open`.
    for (const socket of this.#swarm.connections) {
      room.replicate(socket)
      entry.presence.attach(socket)
    }
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
      ...[...this.#rooms.values()].map(({ room, namespace }) => ({
        key: room.key,
        namespace,
        encryptionKey: room.encryptionKey
      })),
      ...this.#unopened
    ])
  }
}
