import Protomux from 'protomux'
import c, { type Encoding } from 'compact-encoding'

/**
 * Who is around, who is typing, and how far they have read.
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
 * Read receipts are the same argument at a worse ratio. There is one per
 * message per reader, so a room of ten people would append nine permanent
 * blocks for every one anybody actually writes — a log whose bulk is people
 * acknowledging a conversation rather than having it. The roster is the same
 * argument in a different shape: a list of who is online is a statement about
 * this second, and nothing that is only true for a second belongs in something
 * that keeps it forever.
 *
 * ## Where it goes instead
 *
 * Hyperswarm connections are already multiplexed with Protomux — the room's
 * cores share one socket as separate channels. This adds one more, scoped to the
 * room by using its discovery key as the channel id, so two rooms over the same
 * connection do not hear each other. Nothing is written to disk and nothing
 * survives the connection.
 *
 * ## Everything a peer says about itself is a claim
 *
 * A peer announces a wallet address and a writer key and neither is checked,
 * because neither can be from here. Anyone can send any pair of strings. The
 * roster is therefore what people say they are, and **nothing security-relevant
 * may read it**: no access decision, no attribution of a message to an author,
 * no tick that means verified. Only `peers` is unforgeable, and only because
 * the channel is per-connection — inflating that count means opening more
 * connections.
 *
 * Rows are keyed by the writer key claimed, which collapses one peer holding
 * two connections into a single entry, as a sidebar wants. It follows that a
 * peer claiming somebody else's writer key merges into their row and can hang a
 * read receipt on it, making a stranger appear to have read something. That is
 * not a hole to be plugged here. It is the same fact stated again: this is
 * decoration, and the moment anything relies on it, it is being misused.
 *
 * A challenge and response was considered and deliberately left out. Done
 * properly it would prove that whoever holds this socket also holds the wallet
 * key at this instant, and that is worth less than it sounds. The question
 * anyone actually needs answered is who wrote a particular message, and that is
 * already answered, per message, by the signature `verifyAuthor` checks — a
 * proof that travels with the message, survives being handed on by a blind peer
 * nobody trusts, and can be re-checked months later by someone who was not
 * online at the time. A live challenge proves nothing about anything already
 * written, and would cost a round trip on every attach plus a nonce cache to
 * keep it from being replayed. If the roster ever needs to carry weight, the
 * answer is to carry that same per-message signature over this channel, not to
 * invent a second and weaker notion of identity beside it.
 *
 * ## Adding a signal without breaking the peers that predate it
 *
 * Protomux prefixes every frame with a varint message type, and that type is
 * the index the message was registered at with `addMessage`. Its receive path
 * is `if (type < this.messages.length)`: a type past the end of the local list
 * is dropped, not an error and not a disconnect. The tagged union this needs
 * therefore already exists one layer down, and a new signal is simply a new
 * `addMessage` on the same channel — a build that predates it registered fewer
 * messages, ignores the new types in silence, and goes on exchanging the one it
 * knows.
 *
 * That is why the protocol is still `v1` and typing is still a bare `c.bool` at
 * type 0. Both alternatives are worse. A `v2` protocol means either a second
 * channel per connection, doubling the pairing dance described below to carry
 * the same information, or a negotiation whose losing branch leaves older peers
 * with no presence at all. And a self-describing encoding inside type 0 — one
 * tagged so that it could still be read as a bare bool — cannot be made safe:
 * `c.bool` decodes a single byte and returns `byte === 1`, so an old peer handed
 * a tag byte of 2 does not fail loudly, it reads `false` and clears its typing
 * indicator. Every roster announce would look to it like somebody stopping
 * mid-sentence.
 *
 * **The order the messages are registered in is the wire format.** Inserting
 * one anywhere but the end renumbers everything after it, and two builds that
 * disagree about the numbering decode each other's frames as the wrong type —
 * which, unlike a version mismatch, fails silently. Append only.
 *
 * ## Attach order must not matter
 *
 * Two peers rarely reach a connection at the same moment. One creates the room
 * and attaches when the other dials in; the other attaches later, when its own
 * room finishes opening. Protomux rejects an incoming channel for a protocol it
 * has no local channel for, and a rejection closes the opener's side — so
 * without care the earlier peer is refused, closes, and then refuses the later
 * peer in turn. See {@link Presence.attach} for how that is avoided.
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

/**
 * The shapes a claim has to have before it is repeated to anybody.
 *
 * This is where a stranger's bytes turn into something an interface will
 * render, so a claim that is not the right shape is dropped rather than shown.
 * An address is the same `0x` and forty hex characters a signed message
 * carries, which bounds its length — an unbounded string from a stranger ends
 * up in a sidebar — and keeps it comparable with the one place an address is
 * ever actually proven. A message id is what the protocol's own parser accepts,
 * so a receipt can only ever point at something that could be a message.
 * Nothing is repaired: a malformed claim is not a claim.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const WRITER_KEY = /^[0-9a-f]{64}$/
const MESSAGE_ID = /^[0-9a-zA-Z_-]{8,64}$/

/**
 * What a peer says it is.
 *
 * Absence is the empty string rather than an optional field. The validated
 * shapes above cannot produce one, so it cannot be confused with a real value,
 * and an optional would cost a byte and a second decode path to carry a fact
 * that fits in the value itself. Growing this later means a new message type
 * rather than a new field, which is free here for the same reason all of it is
 * ephemeral: there is no history to stay compatible with, only whoever is on
 * the other end of the socket right now.
 */
interface Announce {
  /** Claimed wallet address, or empty when this peer has no wallet attached. */
  readonly address: string
  /** Claimed Autobase writer key, hex. */
  readonly writerKey: string
}

const announceEncoding: Encoding<Announce> = {
  preencode(state, claim) {
    c.string.preencode(state, claim.address)
    c.string.preencode(state, claim.writerKey)
  },
  encode(state, claim) {
    c.string.encode(state, claim.address)
    c.string.encode(state, claim.writerKey)
  },
  decode(state) {
    return { address: c.string.decode(state), writerKey: c.string.decode(state) }
  }
}

interface Channel {
  close(): void
}

interface Message<T> {
  send(value: T): void
}

/** A receipt as it is held locally, stamped with arrival rather than the sender's clock. */
interface Read {
  readonly messageId: string
  readonly at: number
}

interface Remote {
  channel: Channel
  /**
   * One handle per message type. They are named for what they carry, but the
   * tag on the wire is the order they were registered in — see the header.
   */
  sendTyping: Message<boolean>
  sendAnnounce: Message<Announce>
  sendReceipt: Message<string>
  typing: boolean
  expires: number
  /** What this peer says it is, or null until it says. An older build never does. */
  claim: Announce | null
  /** The furthest it admits to having read, or null while it publishes no receipts. */
  read: Read | null
}

/**
 * One peer on the roster, as it describes itself.
 *
 * Every field here except the fact of being connected is a claim the peer made
 * about itself and nobody checked. See the header before using any of it for
 * anything that matters.
 */
export interface PresencePeer {
  /** The Autobase writer key it claims. */
  readonly writerKey: string
  /** The wallet address it claims, or null when it announced none. */
  readonly address: string | null
  /** Whether it is typing right now — the signal `typing` counts, attributed. */
  readonly typing: boolean
  /**
   * The id of the latest message it says it has read, or null. Null is both
   * "has read nothing" and "publishes no receipts", which are deliberately
   * indistinguishable: the default is off, and a peer that has opted out should
   * not be visibly opted out.
   */
  readonly readMessageId: string | null
  /** When that receipt arrived here, by this machine's clock. */
  readonly readAt: number | null
}

export interface PresenceState {
  /** Connections currently carrying this room. */
  readonly peers: number
  /** How many of them are typing right now. */
  readonly typing: number
  /**
   * Who is here, as far as anyone is willing to say.
   *
   * Shorter than `peers` whenever somebody is connected without announcing — an
   * older build, or a blind peer, which speaks only replication. Never longer:
   * a peer holding two connections at once, which Hyperswarm produces routinely
   * while a duplicate is torn down, appears once.
   */
  readonly roster: readonly PresencePeer[]
}

export interface PresenceOptions {
  readonly topic: Uint8Array
  readonly onChange: (state: PresenceState) => void
  /** How long a typing signal counts for without being renewed. */
  readonly ttl?: number
  /**
   * This peer's Autobase writer key, which is what identifies it on the roster.
   * Omit and it joins the count without joining the roster, which is what a
   * peer with nothing to identify itself by should do.
   */
  readonly writerKey?: string
  /** The wallet address to claim, when a wallet is attached. */
  readonly address?: string | null
  /**
   * Publish read receipts. Off unless this is explicitly true, for the reason
   * given on {@link Presence.setReceipts}.
   */
  readonly receipts?: boolean
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
  /** Every multiplexer paired with, so closing can unregister from each. */
  readonly #muxes = new Set<Protomux>()

  /** What this peer announces itself as. Null means it stays off everyone's roster. */
  readonly #writerKey: string | null

  #address: string | null
  #receipts: boolean
  /** The furthest this peer has read, held whether or not it is published. */
  #read: string | null = null
  #typing = false
  #sweep: ReturnType<typeof setInterval> | null = null

  constructor(opts: PresenceOptions) {
    this.#topic = opts.topic
    this.#onChange = opts.onChange
    this.#ttl = opts.ttl ?? TYPING_TTL
    this.#writerKey = opts.writerKey ?? null
    this.#address = opts.address ?? null
    // Compared against true rather than defaulted, so that only the word
    // itself turns receipts on. Anything else — undefined, a truthy string
    // from a config file that was never meant to reach here — leaves them off.
    this.#receipts = opts.receipts === true
  }

  /**
   * Opens the channel on a connection, and agrees to answer if the peer opens
   * first.
   *
   * Both halves are needed, and the second is the one that is easy to miss.
   * Protomux **rejects** an incoming channel for a protocol the local side has
   * not registered — and a rejection closes the opener's channel. Two peers
   * that attach at different moments therefore refuse each other in turn: the
   * earlier one is rejected, closes, and then rejects the later one right back.
   * That deadlock is symmetric and silent, and it survives retrying, because
   * retrying only repeats it.
   *
   * `pair` is the way out. It registers a notifier so that an open for this
   * protocol gets a chance to be answered before it is refused, which makes the
   * order the two sides attach in stop mattering.
   *
   * Safe to call repeatedly for the same socket: opening is guarded on whether
   * a channel is already up.
   */
  attach(socket: unknown): void {
    try {
      const mux = Protomux.from(socket)
      mux.pair({ protocol: PROTOCOL, id: this.#topic }, () => this.#open(mux))
      this.#muxes.add(mux)
      this.#open(mux)
    } catch (err) {
      // Never take the connection handler down with it. Replication shares this
      // socket, and losing a room's messages because a typing indicator could
      // not be set up would be an absurd trade.
      console.error('presence could not attach:', (err as Error).message)
    }
  }

  #open(mux: Protomux): void {
    if (mux.opened({ protocol: PROTOCOL, id: this.#topic })) return

    const remote: Remote = {
      channel: null as unknown as Channel,
      sendTyping: null as unknown as Message<boolean>,
      sendAnnounce: null as unknown as Message<Announce>,
      sendReceipt: null as unknown as Message<string>,
      typing: false,
      expires: 0,
      claim: null,
      read: null
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

    remote.channel = channel

    // These three calls are the wire format. The type that prefixes each frame
    // is the index the message was registered at, so type 0 has to stay the
    // bool every build since the first one speaks, and anything new goes on the
    // end. Reordering them would have two builds decoding each other's frames
    // as the wrong message, silently. See the header.
    remote.sendTyping = channel.addMessage({
      encoding: c.bool,
      onmessage: (typing: boolean) => {
        remote.typing = typing === true
        remote.expires = Date.now() + this.#ttl
        this.#changed()
      }
    })

    remote.sendAnnounce = channel.addMessage({
      encoding: announceEncoding,
      onmessage: (claim: Announce) => {
        // The writer key is what roster entries are keyed by, so garbage there
        // costs the peer its place. An address that does not have the shape a
        // signed message carries is dropped on its own and the peer kept: a
        // build claiming an address in some format this one predates should
        // appear present and unnamed rather than disappear.
        if (!WRITER_KEY.test(claim.writerKey)) return
        remote.claim = {
          address: ADDRESS.test(claim.address) ? claim.address : '',
          writerKey: claim.writerKey
        }
        this.#changed()
      }
    })

    remote.sendReceipt = channel.addMessage({
      encoding: c.string,
      onmessage: (messageId: string) => {
        // An empty id retracts, which is how switching receipts off reaches the
        // people who were already told.
        if (messageId === '') remote.read = null
        else if (MESSAGE_ID.test(messageId)) remote.read = { messageId, at: Date.now() }
        else return
        this.#changed()
      }
    })

    channel.open()
    this.#remotes.add(remote)

    // Whatever this side is doing right now, so a peer arriving mid-sentence
    // sees it rather than waiting for the next keystroke — and mid-conversation
    // sees the roster and the receipt rather than an empty sidebar.
    if (this.#typing) remote.sendTyping.send(true)
    this.#announceTo(remote)
    const read = this.#read
    if (this.#receipts && read !== null) remote.sendReceipt.send(read)
    this.#changed()
  }

  /** Sends this peer's claim about itself, when it has one to make. */
  #announceTo(remote: Remote): void {
    if (this.#writerKey === null) return
    remote.sendAnnounce.send({ address: this.#address ?? '', writerKey: this.#writerKey })
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
    for (const remote of this.#remotes) remote.sendTyping.send(typing)
  }

  /**
   * Re-sends the typing signal, to keep it inside the remote's expiry.
   *
   * Typing only, because it is the only signal with an expiry to stay inside.
   * Renewing the roster or a receipt would put periodic traffic on every
   * connection for the life of the session in order to restate something the
   * peer at the other end already believes.
   */
  refresh(): void {
    if (!this.#typing) return
    for (const remote of this.#remotes) remote.sendTyping.send(true)
  }

  /**
   * Changes the address this peer claims, and tells everyone already connected.
   *
   * The address arrives and departs mid-session, when a wallet is unlocked or
   * locked, so the announce cannot be a one-off at attach. Passing null is what
   * locking looks like from here: the peer stays on the roster and stops being
   * named.
   */
  setAddress(address: string | null): void {
    if (address === this.#address) return
    this.#address = address
    for (const remote of this.#remotes) this.#announceTo(remote)
  }

  /** Whether this peer is publishing read receipts. */
  get receipts(): boolean {
    return this.#receipts
  }

  /**
   * Publishes read receipts, or stops.
   *
   * Off unless something explicitly asked for it, and it has to be that way
   * round. A receipt reports when you looked at what somebody wrote, which is a
   * fact about your attention rather than about the conversation, and the
   * person it exposes is the one who never got asked. Nothing should turn this
   * on but a setting a person chose.
   *
   * Switching it off retracts at once rather than letting anything lapse, and
   * that is also why no receipt needs a TTL. A live connection carries the
   * retraction in order, and a connection that is not live has already taken
   * the whole remote with it, so there is no window in which a claim about this
   * peer's reading outlives its consent.
   */
  setReceipts(enabled: boolean): void {
    if (enabled === this.#receipts) return
    this.#receipts = enabled

    // Nothing has been published and nothing needs retracting until something
    // has been read.
    const read = this.#read
    if (read === null) return

    // Enabling publishes the position already recorded instead of waiting for
    // the next read. Staying quiet until something new arrives would make the
    // switch look broken in a quiet room, and what it discloses is where this
    // peer has got to now — which is the thing the switch is consent for.
    for (const remote of this.#remotes) remote.sendReceipt.send(enabled ? read : '')
  }

  /**
   * Records how far this peer has read, and publishes it if receipts are on.
   *
   * The position is kept either way, so that turning receipts on later has
   * something to say. While they are off it never leaves this machine.
   */
  setRead(messageId: string | null): void {
    if (messageId === this.#read) return
    this.#read = messageId
    if (!this.#receipts) return
    // Deliberately not validated on the way out. The check lives where a
    // stranger's bytes arrive, and one check is easier to keep honest than two
    // that have to agree with each other.
    for (const remote of this.#remotes) remote.sendReceipt.send(messageId ?? '')
  }

  get state(): PresenceState {
    const now = Date.now()
    let typing = 0
    // Keyed by the writer key claimed, which is what collapses one peer holding
    // two connections into one row.
    const rows = new Map<string, { address: string | null; typing: boolean; read: Read | null }>()

    for (const remote of this.#remotes) {
      const active = remote.typing && remote.expires > now
      if (active) typing += 1

      const claim = remote.claim
      if (claim === null) continue

      const row = rows.get(claim.writerKey)
      if (row === undefined) {
        rows.set(claim.writerKey, {
          address: claim.address === '' ? null : claim.address,
          typing: active,
          read: remote.read
        })
        continue
      }

      // The same writer key twice, which is normally the same peer over two
      // connections and occasionally a peer claiming to be somebody it is not.
      // Nothing here can tell those apart, so take the union of what was said
      // and the newer of two receipts, and see the header for why that is
      // tolerable rather than a hole.
      if (active) row.typing = true
      if (row.address === null && claim.address !== '') row.address = claim.address
      if (remote.read !== null && (row.read === null || remote.read.at > row.read.at)) {
        row.read = remote.read
      }
    }

    return {
      peers: this.#remotes.size,
      typing,
      roster: [...rows].map(([writerKey, row]) => ({
        writerKey,
        address: row.address,
        typing: row.typing,
        readMessageId: row.read?.messageId ?? null,
        readAt: row.read?.at ?? null
      }))
    }
  }

  /**
   * Starts expiring stale typing signals.
   *
   * Separate from the constructor so a room that nobody is watching does not
   * hold a timer, and so tests can drive expiry directly.
   *
   * Typing is the only thing swept, and the other two signals are left alone on
   * purpose. A roster entry and a receipt stay true until the peer says
   * otherwise or the connection carrying them goes, and the connection going
   * already deletes the remote outright — so an expiry could only ever fire
   * while the peer is demonstrably still there, hiding somebody who is present
   * or a receipt that is still accurate. Typing is different because the update
   * most likely to go missing is "I stopped": a peer that shuts its laptop
   * mid-word sends nothing, and silence has to be read as having stopped rather
   * than as still going.
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
    // Leaving the notifier behind would have a closed room answering opens for
    // a channel it no longer has.
    for (const mux of this.#muxes) {
      try {
        mux.unpair({ protocol: PROTOCOL, id: this.#topic })
      } catch {
        // The stream is already gone, which is the common case.
      }
    }
    this.#muxes.clear()
  }

  #changed(): void {
    this.#onChange(this.state)
  }
}
