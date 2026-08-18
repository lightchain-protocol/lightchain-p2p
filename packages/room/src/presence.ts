import Protomux from 'protomux'
import c from 'compact-encoding'

/**
 * Who is around, and who is typing.
 *
 * ## Why none of this is in the room
 *
 * A room is an Autobase. Every block written to one is signed, replicated to
 * every member and kept forever — it cannot be edited, pruned or migrated. That
 * is exactly right for what somebody said and exactly wrong for the fact that
 * they are, at this instant, still saying it.
 *
 * A typing indicator changes several times a sentence and is worthless a second
 * later. Five people talking for an hour would append thousands of permanent
 * blocks of noise, outweighing the conversation they belong to, on every
 * member's disk, for the life of the room. So presence goes over a channel that
 * stores nothing.
 *
 * ## Where it goes instead
 *
 * Hyperswarm connections are already multiplexed with Protomux — the room's
 * cores share one socket as separate channels. This adds one more, scoped to the
 * room by using its discovery key as the channel id, so two rooms over the same
 * connection do not hear each other. Nothing is written to disk and nothing
 * survives the connection.
 *
 * ## Why nobody is named
 *
 * A peer could claim any identity over this channel, and a name on screen that
 * anyone can forge is worse than no name. Counting is enough for what this is
 * for, and counting cannot be forged: one connection is one peer, and the
 * channel is per-connection, so a peer cannot inflate the count without opening
 * more connections.
 *
 * Naming would mean a signed challenge and response. That is a reasonable thing
 * to add and is deliberately not here yet.
 *
 * ## Known limit: this does not yet establish inside the application
 *
 * Between two peers on a local DHT — which is what the tests here drive — the
 * channel opens, typing crosses, it expires on its own and it writes nothing
 * into the room. All of that passes.
 *
 * Inside `apps/chat` it does not. Over a real pairing the remote closes the
 * channel immediately, every time: the stream stays alive, `onopen` never
 * fires, and retrying only produced 57 opens and 57 closes. Messages replicate
 * normally throughout, so the connection itself is healthy. The difference from
 * the tests is the company the socket keeps — blind-pairing, the wakeup
 * protocol, Corestore replication and Autobase all multiplex over it, and the
 * worker runs under Bare rather than Node.
 *
 * The cause is not established, so nothing here is wired to a user-facing
 * indicator: a typing dot that never appears is worse than none, because it
 * teaches people the room is quiet when it is not.
 */

const PROTOCOL = 'lightchain/presence/v1'

/**
 * How long a typing signal counts for without being renewed.
 *
 * Needed because "stopped typing" can go missing: a peer that closes its laptop
 * mid-word sends nothing, and without an expiry the indicator would say they
 * are still typing until the connection finally drops, which can be minutes.
 */
export const TYPING_TTL = 6_000

/** Renewed at this interval while someone keeps typing. Comfortably inside the TTL. */
export const TYPING_REFRESH = 2_500

interface Channel {
  close(): void
}

interface Message {
  send(value: boolean): void
}

interface Remote {
  channel: Channel
  message: Message
  typing: boolean
  expires: number
}

export interface PresenceState {
  /** Connections currently carrying this room. */
  readonly peers: number
  /** How many of them are typing right now. */
  readonly typing: number
}

/**
 * The presence channel for one room, across every connection it has.
 *
 * Instantiated by the host, which owns the sockets. Rooms do not know about
 * connections and should not start.
 */
export class Presence {
  readonly #topic: Uint8Array
  readonly #onChange: (state: PresenceState) => void
  readonly #ttl: number
  readonly #remotes = new Set<Remote>()

  #typing = false
  #sweep: ReturnType<typeof setInterval> | null = null

  constructor(opts: { topic: Uint8Array; onChange: (state: PresenceState) => void; ttl?: number }) {
    this.#topic = opts.topic
    this.#onChange = opts.onChange
    this.#ttl = opts.ttl ?? TYPING_TTL
  }

  /**
   * Opens the channel on a connection.
   *
   * Safe to call for a socket that already has one: Protomux refuses a
   * duplicate protocol and id, and this returns without a second channel rather
   * than throwing. The host calls it for every room on every connection.
   */
  attach(socket: unknown): void {
    try {
      this.#attach(socket)
    } catch (err) {
      // Never take the connection handler down with it. Replication shares this
      // socket, and losing a room's messages because a typing indicator could
      // not be set up would be an absurd trade.
      console.error('presence could not attach:', (err as Error).message)
    }
  }

  #attach(socket: unknown): void {
    const mux = Protomux.from(socket as never)
    if (mux.opened({ protocol: PROTOCOL, id: this.#topic })) return

    const remote: Remote = {
      channel: null as unknown as Channel,
      message: null as unknown as Message,
      typing: false,
      expires: 0
    }

    const channel = mux.createChannel({
      protocol: PROTOCOL,
      id: this.#topic,
      onclose: () => {
        this.#remotes.delete(remote)
        this.#changed()
      }
    })

    // Null means the stream is gone or a channel is already open, not that the
    // remote is too old. A peer that never opens its side of this channel — an
    // older build, or a blind peer, which speaks only replication — leaves it
    // quiet, and quiet is indistinguishable from "not typing", which is right.
    if (channel === null) return

    remote.channel = channel as unknown as Channel
    remote.message = channel.addMessage({
      encoding: c.bool,
      onmessage: (typing: boolean) => {
        remote.typing = typing === true
        remote.expires = Date.now() + this.#ttl
        this.#changed()
      }
    }) as unknown as Message

    channel.open()
    this.#remotes.add(remote)

    // Whatever this side is doing right now, so a peer arriving mid-sentence
    // sees it rather than waiting for the next keystroke.
    if (this.#typing) remote.message.send(true)
    this.#changed()
  }

  /**
   * Says whether this peer is typing, to everyone in the room.
   *
   * Idempotent: repeating `true` while already typing sends nothing, so a
   * caller can invoke this on every keystroke. Renewal against the TTL is the
   * caller's job, through {@link refresh}.
   */
  setTyping(typing: boolean): void {
    if (typing === this.#typing) return
    this.#typing = typing
    for (const remote of this.#remotes) remote.message.send(typing)
  }

  /** Re-sends the current state, to keep it inside the remote's expiry. */
  refresh(): void {
    if (!this.#typing) return
    for (const remote of this.#remotes) remote.message.send(true)
  }

  get state(): PresenceState {
    const now = Date.now()
    let typing = 0
    for (const remote of this.#remotes) {
      if (remote.typing && remote.expires > now) typing += 1
    }
    return { peers: this.#remotes.size, typing }
  }

  /**
   * Starts expiring stale typing signals.
   *
   * Separate from the constructor so a room that nobody is watching does not
   * hold a timer, and so tests can drive expiry directly.
   */
  start(): void {
    if (this.#sweep) return
    this.#sweep = setInterval(() => {
      const now = Date.now()
      let stale = false
      for (const remote of this.#remotes) {
        if (remote.typing && remote.expires <= now) {
          remote.typing = false
          stale = true
        }
      }
      if (stale) this.#changed()
    }, 1_000)
    this.#sweep.unref?.()
  }

  close(): void {
    if (this.#sweep) clearInterval(this.#sweep)
    this.#sweep = null
    for (const remote of this.#remotes) remote.channel.close()
    this.#remotes.clear()
  }

  #changed(): void {
    this.#onChange(this.state)
  }
}
