import { connect } from '#socket'
import {
  createSession,
  disputeResponseMismatch,
  job,
  keccak256,
  resolveAddresses,
  sendTransaction,
  toBytes,
  toHex,
  type Account,
  type Rpc
} from '@lcai-p2p/chain'
import { decrypt, encrypt, encryptSessionKey, generateSessionKey } from '@lcai-p2p/inference-crypto'
import { Api, ApiError, type Draw, type Model } from './api.js'
import { decodeKey, encodeSealed } from './keys.js'
import { checkCommitment, verifyFrame, type Commitment } from './verify.js'

/**
 * One conversation with one model.
 *
 * A session is expensive to establish — a sortition draw takes the better part
 * of a minute and creates a transaction — so it is made once and reused for
 * every question after. The session key never leaves this object, and the
 * service that carries the prompts cannot read them.
 */

export interface ConversationOptions {
  readonly api: Api
  readonly relayUrl: string
  readonly model: Model
  /**
   * Needed to send the `createSession` transaction where the deployment has no
   * sortition, and to check the signature on every answer.
   */
  readonly chain?: {
    readonly rpc: Rpc
    readonly account: Account
    /**
     * The chain the caller expects, refused if the node says otherwise.
     *
     * Passed through to `sendTransaction`, which will not sign against a node
     * answering for a different chain. Omitting it means trusting whatever the
     * RPC claims to be, which is the thing the chain id exists to prevent.
     */
    readonly chainId?: bigint
  }
  /**
   * Whether to check that the assigned worker signed each answer. On by
   * default: an unverified answer is one a relay could have written.
   */
  readonly verify?: boolean
}

export interface Answer {
  readonly jobId: string
  readonly text: string
}

export type Progress =
  | { readonly phase: 'drawing' }
  | { readonly phase: 'opening'; readonly worker: string }
  | { readonly phase: 'ready'; readonly sessionId: string; readonly worker: string }
  | { readonly phase: 'submitting' }
  | { readonly phase: 'waiting'; readonly jobId: string }
  | { readonly phase: 'token'; readonly text: string }
  | { readonly phase: 'done'; readonly jobId: string }

/** The event that carries the id the contract assigned. */
const SESSION_CREATED = 'SessionCreated(uint256,address,bytes32,address,bytes,bytes)'

export class ConversationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationError'
  }
}

export class Conversation {
  readonly model: Model
  readonly #api: Api
  readonly #relayUrl: string

  #sessionKey: Uint8Array | null = null
  #sessionId: string | null = null
  #worker: string | null = null
  #socket: { close(): void } | null = null
  /** Non-null while a start is in flight, so a second one is refused rather than leaked. */
  #starting: Promise<void> | null = null
  /**
   * Bumped every time the socket is replaced. Handlers capture the generation
   * they were registered with, so a socket a reopen left behind cannot settle
   * a wait that outlived it.
   */
  #generation = 0
  /**
   * The job currently being answered, if any. Frames naming any other job —
   * or arriving while no job is waiting — are the tail of one that timed out
   * or was cancelled, and are dropped rather than collected.
   */
  #activeJob: string | null = null

  /** Resolvers for the answer currently in flight, if any. */
  #pending: { resolve(text: string): void; reject(error: Error): void } | null = null
  /** By sequence number, so duplicates collapse and order is the wire's, not arrival's. */
  #chunks = new Map<number, string>()
  /**
   * The signed frames behind the last answer, kept so it can be quoted to
   * somebody else with the evidence attached.
   */
  #evidence = new Map<number, { ciphertext: string; signature: string }>()

  readonly #chain: ConversationOptions['chain']
  readonly #verify: boolean

  /** What the signature check needs, learned once when the session opens. */
  #chainId: number | null = null
  #jobRegistry: string | null = null

  constructor({ api, relayUrl, model, chain, verify = true }: ConversationOptions) {
    this.#api = api
    this.#relayUrl = relayUrl.replace(/\/$/, '')
    this.model = model
    this.#chain = chain
    this.#verify = verify
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  get worker(): string | null {
    return this.#worker
  }

  get open(): boolean {
    return this.#sessionId !== null && this.#socket !== null
  }

  /**
   * Draws a worker, seals a session key to it, and opens the relay.
   *
   * The relay is connected before any prompt is sent. Connecting afterwards
   * races the first tokens, and a dropped chunk is a paid answer with a hole
   * in it.
   */
  async start(onProgress: (progress: Progress) => void = () => {}): Promise<void> {
    if (this.open) return
    // A start takes the better part of a minute — a draw, a transaction, a
    // socket — and nothing in that time sets `open`, so a second call before
    // the first finished would draw a second worker and leak the first one's
    // session and socket. Refuse it instead.
    if (this.#starting) {
      throw new ConversationError(
        'the conversation is already being started. Wait for that to finish first.'
      )
    }

    const starting = this.#open(onProgress)
    this.#starting = starting
    try {
      await starting
    } finally {
      this.#starting = null
    }
  }

  async #open(onProgress: (progress: Progress) => void): Promise<void> {
    const flavour = await this.#api.flavour()

    onProgress({ phase: 'drawing' })
    let drawn: Draw
    try {
      drawn =
        flavour === 'sortition'
          ? await this.#api.draw(this.model.id)
          : await this.#api.select(this.model.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        // A draw that times out means nobody is answering for this model, which
        // is not the same as the request being wrong.
        throw new ConversationError(
          `no worker is running ${this.model.name} at the moment. Try another model.`
        )
      }
      throw err
    }

    onProgress({ phase: 'opening', worker: drawn.worker })

    const sessionKey = generateSessionKey()
    const workerKey = decodeKey(drawn.workerKey)
    const disputerKey = decodeKey(drawn.disputerKey)

    const sessionId =
      flavour === 'sortition'
        ? await this.#openBySortition(drawn, sessionKey, workerKey, disputerKey)
        : await this.#openOnChain(sessionKey, workerKey, disputerKey)

    this.#sessionKey = sessionKey
    this.#sessionId = sessionId
    this.#worker = drawn.worker

    if (this.#verify) {
      if (!this.#chain) {
        throw new ConversationError(
          'answers cannot be checked without a chain client. Pass one, or set verify: false and know what that means.'
        )
      }
      // Both are part of what the worker signed, so they are fetched once here
      // rather than per frame.
      this.#chainId = await this.#chain.rpc.chainId()
      this.#jobRegistry = (await resolveAddresses(this.#chain.rpc)).jobRegistry
    }

    const token = await this.#api.relayToken(sessionId)
    // Handlers are pinned to the generation they were registered with, so a
    // socket that a reopen replaced cannot reject — or resolve — a wait that
    // outlived it.
    const generation = ++this.#generation
    this.#socket = await connect(`${this.#relayUrl}?token=${token}`, {
      onMessage: (frame) => this.#onFrame(frame, onProgress),
      onClose: () => {
        if (generation !== this.#generation) return
        this.#socket = null
        this.#pending?.reject(new ConversationError('the relay closed before the answer finished'))
        this.#pending = null
      },
      onError: (error) => {
        if (generation !== this.#generation) return
        this.#pending?.reject(error)
        this.#pending = null
      }
    })

    onProgress({ phase: 'ready', sessionId, worker: drawn.worker })
  }

  /**
   * Opens a fresh session in place of one the chain expired.
   *
   * The question in flight is deliberately kept waiting across the reopen —
   * the asker asked once and should be answered once. The generation is
   * bumped before the old socket is closed, so its close event reaching the
   * handlers afterwards cannot reject that wait.
   */
  async #reopen(onProgress: (progress: Progress) => void): Promise<void> {
    const socket = this.#socket
    this.#generation++
    this.#socket = null
    this.#sessionKey = null
    this.#sessionId = null
    socket?.close()
    await this.start(onProgress)
  }

  /** The service sends the transaction, having drawn the worker itself. */
  async #openBySortition(
    drawn: Draw,
    sessionKey: Uint8Array,
    workerKey: Uint8Array,
    disputerKey: Uint8Array
  ): Promise<string> {
    const session = await this.#api.openSession(
      drawn.requestId as string,
      encodeSealed(encryptSessionKey(sessionKey, workerKey), 'hex'),
      encodeSealed(encryptSessionKey(sessionKey, disputerKey), 'hex')
    )
    return session.sessionId
  }

  /**
   * We send the transaction, having collected a signature.
   *
   * The session id comes back from the service afterwards rather than being
   * parsed out of the receipt's logs: the service is watching the chain
   * anyway, and decoding an event to learn a number it already knows is more
   * that can silently go wrong.
   */
  async #openOnChain(
    sessionKey: Uint8Array,
    workerKey: Uint8Array,
    disputerKey: Uint8Array
  ): Promise<string> {
    if (!this.#chain) {
      throw new ConversationError(
        'this network needs the session created on chain, which needs an unlocked wallet'
      )
    }

    const encWorkerKey = encryptSessionKey(sessionKey, workerKey)
    const encDisputerKey = encryptSessionKey(sessionKey, disputerKey)

    const prepared = await this.#api.prepare(
      this.model.id,
      encodeSealed(encWorkerKey, 'base64'),
      encodeSealed(encDisputerKey, 'base64')
    )

    const { rpc, account } = this.#chain
    const { jobRegistry } = await resolveAddresses(rpc)

    const sent = await sendTransaction(rpc, account, {
      to: jobRegistry,
      data: createSession({
        modelId: this.model.id,
        worker: prepared.worker,
        encWorkerKey,
        encDisputerKey,
        dispatcherSignature: toBytes(
          prepared.signature.startsWith('0x') ? prepared.signature : `0x${prepared.signature}`
        ),
        expiry: prepared.expiry
      }),
      ...(this.#chain.chainId === undefined ? {} : { chainId: this.#chain.chainId })
    })

    const receipt = await sent.wait()
    if (!receipt.status) {
      throw new ConversationError(`creating the session reverted (${sent.hash})`)
    }

    // The contract assigns the id, and the only place it reports it is the
    // event. `SessionCreated(uint256 indexed sessionId, ...)` puts it in the
    // first indexed topic.
    const topic = toHex(keccak256(new TextEncoder().encode(SESSION_CREATED)))
    const log = receipt.logs.find((entry) => entry.topics[0]?.toLowerCase() === topic.toLowerCase())

    if (!log?.topics[1]) {
      throw new ConversationError(
        `the session transaction was mined (${sent.hash}) but emitted no SessionCreated event`
      )
    }

    return BigInt(log.topics[1]).toString()
  }

  #assemble(): string {
    return [...this.#chunks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join('')
  }

  #onFrame(frame: string, onProgress: (progress: Progress) => void): void {
    let message: {
      type?: string
      payload?: string
      jobId?: string | number
      error?: string
      seq?: number
      signature?: string
    }
    try {
      message = JSON.parse(frame)
    } catch {
      return
    }

    // The job a frame belongs to, when it says. Frames keep arriving for jobs
    // nobody is waiting on any more — the tail of an answer that timed out,
    // or of one that was cancelled — and are dropped rather than collected:
    // what is gathered here is the evidence `commitment()` and `dispute()`
    // quote, and frames gathered after the wait ended make a partial answer
    // indistinguishable from a short one.
    const frameJob =
      message.jobId === undefined || message.jobId === null ? null : String(message.jobId)
    const stale =
      this.#activeJob === null || (frameJob !== null && frameJob !== this.#activeJob)

    // Any frame may carry text, and which one does is a property of the
    // deployment rather than of the protocol: testnet streams `chunk` frames
    // and ends with an empty `complete`, while mainnet sends the whole answer
    // as the payload of a single `complete`. Keying on the payload rather than
    // on the type handles both, and would have saved a paid job that arrived
    // and was thrown away.
    if (message.payload && this.#sessionKey && !stale) {
      // Keyed by sequence number, because the same text arrives twice: testnet
      // streams a `chunk` and then repeats the last one as the payload of
      // `complete`. Appending blindly answered "okok" to a one-word question.
      const seq = typeof message.seq === 'number' ? message.seq : this.#chunks.size

      if (!this.#chunks.has(seq)) {
        const ciphertext = new Uint8Array(Buffer.from(message.payload, 'base64'))

        // Checked before it is decrypted, let alone shown. An answer that the
        // assigned worker did not sign is one the relay could have written.
        if (this.#verify) {
          try {
            verifyFrame(
              {
                chainId: this.#chainId as number,
                jobRegistry: this.#jobRegistry as string,
                jobId: BigInt(message.jobId ?? 0),
                sessionId: BigInt(this.#sessionId ?? 0),
                ciphertext,
                signature: message.signature ?? ''
              },
              this.#worker as string
            )
          } catch (err) {
            this.#pending?.reject(err as Error)
            this.#pending = null
            return
          }
        }

        let text: string
        try {
          text = new TextDecoder().decode(decrypt(this.#sessionKey, ciphertext))
        } catch {
          // Something that will not decrypt is not ours, and guessing at it
          // would put plausible nonsense in front of someone who paid.
          this.#pending?.reject(new ConversationError('part of the answer could not be decrypted'))
          this.#pending = null
          return
        }

        this.#chunks.set(seq, text)
        this.#evidence.set(seq, {
          ciphertext: message.payload,
          signature: message.signature ?? ''
        })
        onProgress({ phase: 'token', text })
      }
    }

    if (message.type === 'complete') {
      if (stale) return
      const text = this.#assemble()
      if (text === '') {
        // The job was submitted and paid for. Saying so beats a blank bubble
        // that looks like the model had nothing to say.
        this.#pending?.reject(
          new ConversationError(
            `job ${message.jobId ?? '?'} finished without returning any text. It was paid for.`
          )
        )
      } else {
        this.#pending?.resolve(text)
      }
      this.#pending = null
      return
    }

    if (message.type === 'error') {
      if (stale) return
      this.#pending?.reject(new ConversationError(message.error ?? 'the worker reported an error'))
      this.#pending = null
    }
  }

  /**
   * Asks a question and waits for the whole answer.
   *
   * Tokens arrive through `onProgress` as they stream, so a caller that wants
   * to render them as they come does not have to wait for this to resolve.
   */
  async ask(
    prompt: string,
    onProgress: (progress: Progress) => void = () => {},
    timeout = 180_000
  ): Promise<Answer> {
    if (!this.open || !this.#sessionKey || !this.#sessionId) {
      throw new ConversationError('the conversation has not been started')
    }
    if (this.#pending) {
      throw new ConversationError('a question is already waiting for an answer')
    }
    if (prompt.trim() === '') throw new ConversationError('the prompt is empty')

    this.#chunks.clear()
    this.#evidence.clear()

    const answer = new Promise<string>((resolve, reject) => {
      this.#pending = { resolve, reject }
    })

    onProgress({ phase: 'submitting' })
    const ciphertext = Buffer.from(
      encrypt(this.#sessionKey, new TextEncoder().encode(prompt))
    ).toString('base64')

    let jobId: string
    try {
      try {
        jobId = await this.#submit(ciphertext)
      } catch (err) {
        // The chain expires a session that has sat idle for
        // `sessionInactivityTimeout` (thirty minutes), and everything
        // submitted to it afterwards reverts with SessionNotActive. That is a
        // fact about the session, not about the question, so the question
        // survives it: open a fresh session and submit once more.
        if (!isSessionNotActive(err)) throw err
        await this.#reopen(onProgress)
        jobId = await this.#submit(ciphertext)
      }
    } catch (err) {
      // Whatever failed, nothing will settle the promise above now. Clear the
      // pending slot so the next ask is not told a question is in flight
      // forever — until today, a failed submit wedged the session exactly so —
      // and give the abandoned promise a rejection handler, because the relay
      // closing later would otherwise reject it unhandled, which in a Bare
      // worker is a process crash.
      answer.catch(() => {})
      this.#pending = null
      throw err
    }

    this.#activeJob = jobId
    onProgress({ phase: 'waiting', jobId })

    let timer: ReturnType<typeof setTimeout> | undefined
    let text: string
    try {
      text = await Promise.race([
        answer,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                // The job is submitted and paid whether or not the answer
                // arrives, so this says so rather than implying a retry is free.
                new ConversationError(
                  `job ${jobId} produced no answer within ${Math.round(timeout / 1000)}s. It was submitted and paid for; the worker may still respond.`
                )
              ),
            timeout
          )
        })
      ])
    } catch (err) {
      // Whatever ended the wait — timeout, relay close, worker error, a frame
      // that failed verification — what was gathered is part of an answer,
      // and part of an answer is not evidence: `commitment()` would be
      // checking a ciphertext against a hash nobody committed to as one.
      this.#chunks.clear()
      this.#evidence.clear()
      throw err
    } finally {
      clearTimeout(timer)
      this.#pending = null
      this.#activeJob = null
    }

    onProgress({ phase: 'done', jobId })
    return { jobId, text }
  }

  /**
   * Uploads the prompt blob and submits the job against the current session.
   *
   * One method because the two are retried together after a session expiry:
   * the blob upload carries the session id too, so uploading against the dead
   * one and only failing at submit would leave a blob nobody can reference.
   */
  async #submit(ciphertext: string): Promise<string> {
    const sessionId = this.#sessionId
    if (!sessionId) throw new ConversationError('the conversation has not been started')
    const blobHash = await this.#api.putBlob(sessionId, ciphertext)
    return this.#api.submit(sessionId, blobHash)
  }

  /**
   * Whether the worker recorded on chain the answer it actually sent.
   *
   * Checked after the fact rather than before showing the answer, because the
   * registry needs a moment to reach `completed` and blocking the reply on a
   * chain read would make every answer feel slow to protect against something
   * that has never happened.
   */
  async commitment(jobId: string, attempts = 20, interval = 3000): Promise<Commitment> {
    if (!this.#chain) return { status: 'pending', state: 'unknown' }

    const evidence = this.evidence()
    if (!evidence) return { status: 'pending', state: 'unquotable' }

    const ciphertext = new Uint8Array(Buffer.from(evidence.ciphertext, 'base64'))
    const { jobRegistry } = await resolveAddresses(this.#chain.rpc)

    // The relay delivers the answer before the registry has recorded it, so a
    // single read almost always finds the job still acknowledged — and
    // reporting that as the result means the check silently never happens.
    let last: Commitment = { status: 'pending', state: 'unread' }

    for (let attempt = 0; attempt < attempts; attempt++) {
      const record = await job(this.#chain.rpc, jobRegistry, BigInt(jobId))
      last = checkCommitment(record.responseCiphertextHash, record.state, ciphertext)
      if (last.status !== 'pending') return last
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    return last
  }

  /**
   * Files the dispute, when there are grounds for one.
   *
   * Only reachable where the answer was validly signed and the recorded hash
   * differs — the contract checks the signature itself and refuses a dispute
   * against a worker that did nothing. The fee comes back and the worker is
   * slashed, so this is not a gesture.
   */
  async dispute(jobId: string): Promise<string> {
    if (!this.#chain) throw new ConversationError('disputing needs a chain client')

    const evidence = this.evidence()
    if (!evidence) throw new ConversationError('there is no single signed answer to dispute')

    const { jobRegistry } = await resolveAddresses(this.#chain.rpc)
    const sent = await sendTransaction(this.#chain.rpc, this.#chain.account, {
      to: jobRegistry,
      data: disputeResponseMismatch(
        BigInt(jobId),
        new Uint8Array(Buffer.from(evidence.ciphertext, 'base64')),
        toBytes(evidence.signature)
      ),
      ...(this.#chain.chainId === undefined ? {} : { chainId: this.#chain.chainId })
    })

    const receipt = await sent.wait()
    if (!receipt.status) throw new ConversationError(`the dispute reverted (${sent.hash})`)
    return sent.hash
  }

  /**
   * Everything needed to quote the last answer to somebody else, however many
   * pieces it arrived in.
   *
   * Each frame is signed over its own ciphertext, so a streamed answer has no
   * single artifact covering the whole text — it has one per piece, in order,
   * and a reader checks all of them and joins the result. Handing back only the
   * first used to be the alternative, and it was refused instead, correctly:
   * one piece's evidence beside all of the text looks like proof of something
   * it does not prove.
   *
   * Null only when there is nothing to quote, or when a frame arrived unsigned
   * — an unsigned piece cannot be checked by anybody, and quoting the rest
   * around it would hide that.
   */
  answerFrames(): {
    frames: { ciphertext: string; signature: string }[]
    sessionKey: string
  } | null {
    if (this.#evidence.size === 0 || !this.#sessionKey) return null

    const frames = [...this.#evidence.entries()].sort(([a], [b]) => a - b).map(([, frame]) => frame)

    if (frames.some((frame) => !frame.signature)) return null

    return { frames, sessionKey: toHex(this.#sessionKey) }
  }

  /**
   * The single signed frame behind the last answer, where there was only one.
   *
   * Narrower than {@link answerFrames} on purpose, and kept for the two things
   * that genuinely need one artifact: `commitment` compares a ciphertext to the
   * hash the registry recorded, and `dispute` submits one to the contract.
   * Neither has a defined meaning for a response the worker sent in pieces, and
   * guessing at one would file a dispute on a reading of the protocol nobody
   * has confirmed.
   */
  evidence(): { ciphertext: string; sessionKey: string; signature: string } | null {
    if (this.#evidence.size !== 1 || !this.#sessionKey) return null

    const [only] = [...this.#evidence.values()]
    if (!only?.signature) return null

    return {
      ciphertext: only.ciphertext,
      sessionKey: toHex(this.#sessionKey),
      signature: only.signature
    }
  }

  /**
   * Stops waiting for the answer in flight.
   *
   * Stops *waiting* — it does not stop the job. That was submitted and paid for
   * the moment it went on chain, and no message exists to recall it. What this
   * gives back is the interface, not the fee, and the error says so.
   */
  cancel(): boolean {
    if (!this.#pending) return false

    this.#pending.reject(
      new ConversationError('stopped waiting. The job was already submitted and paid for.')
    )
    this.#pending = null
    this.#activeJob = null
    // Whatever arrives now is the tail of a job nobody is waiting on; keeping
    // it would pass part of an answer off as the evidence for one.
    this.#chunks.clear()
    this.#evidence.clear()
    return true
  }

  close(): void {
    this.cancel()
    this.#generation++
    this.#socket?.close()
    this.#socket = null
    this.#sessionKey = null
    this.#sessionId = null
  }
}

/**
 * Whether an API failure is the chain refusing a session that sat idle too
 * long.
 *
 * `AIConfig.sessionInactivityTimeout` is thirty minutes, after which the
 * session is expired on chain and every submission to it reverts with
 * `SessionNotActive`. The service passes the revert reason through in the
 * error message, which is the only place it can be read from.
 */
function isSessionNotActive(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  const text = `${err.code ?? ''} ${err.message}`.replace(/[^a-z0-9]/gi, '')
  return /sessionnotactive/i.test(text)
}
