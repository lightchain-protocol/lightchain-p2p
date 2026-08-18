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
  readonly chain?: { readonly rpc: Rpc; readonly account: Account }
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
    this.#socket = await connect(`${this.#relayUrl}?token=${token}`, {
      onMessage: (frame) => this.#onFrame(frame, onProgress),
      onClose: () => {
        this.#socket = null
        this.#pending?.reject(new ConversationError('the relay closed before the answer finished'))
        this.#pending = null
      },
      onError: (error) => {
        this.#pending?.reject(error)
        this.#pending = null
      }
    })

    onProgress({ phase: 'ready', sessionId, worker: drawn.worker })
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
      })
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

    // Any frame may carry text, and which one does is a property of the
    // deployment rather than of the protocol: testnet streams `chunk` frames
    // and ends with an empty `complete`, while mainnet sends the whole answer
    // as the payload of a single `complete`. Keying on the payload rather than
    // on the type handles both, and would have saved a paid job that arrived
    // and was thrown away.
    if (message.payload && this.#sessionKey) {
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

    const blobHash = await this.#api.putBlob(this.#sessionId, ciphertext)
    const jobId = await this.#api.submit(this.#sessionId, blobHash)
    onProgress({ phase: 'waiting', jobId })

    let timer: ReturnType<typeof setTimeout> | undefined
    const text = await Promise.race([
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
    ]).finally(() => {
      clearTimeout(timer)
      this.#pending = null
    })

    onProgress({ phase: 'done', jobId })
    return { jobId, text }
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
      )
    })

    const receipt = await sent.wait()
    if (!receipt.status) throw new ConversationError(`the dispute reverted (${sent.hash})`)
    return sent.hash
  }

  /**
   * Everything needed to quote the last answer to somebody else.
   *
   * Null when the answer arrived in more than one frame. Each frame is signed
   * over its own ciphertext, so a chunked answer has no single artifact that
   * covers the whole text — and posting one chunk's evidence beside all of the
   * text would look like proof of something it does not prove. Refusing is the
   * only honest option until the format carries a list.
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
    return true
  }

  close(): void {
    this.cancel()
    this.#socket?.close()
    this.#socket = null
    this.#sessionKey = null
    this.#sessionId = null
  }
}
