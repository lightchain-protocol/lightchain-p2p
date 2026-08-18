import fetch from '#fetch'

/**
 * The consumer API.
 *
 * A thin, honest wrapper: it authenticates, and otherwise its job is to make
 * failures legible. Every call here can fail in a way that costs money or
 * leaves a session half-made, so nothing is retried silently and nothing is
 * assumed about a response that did not arrive.
 */

export class ApiError extends Error {
  readonly status: number
  /** The service's own error code, where it gave one. */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface ApiOptions {
  readonly url: string
  /**
   * Sortition takes twenty to forty-five seconds, because it is drawing from
   * workers that are actually online. A timeout tuned to an ordinary request
   * would abandon every draw.
   */
  readonly timeout?: number
}

export interface Model {
  readonly id: string
  readonly name: string
}

export interface Balance {
  /** Prepaid, in wei, as the service sees it. */
  readonly balance: bigint
  /** The address that must be authorised before anything works. */
  readonly delegate: string
  readonly delegateAuthorized: boolean
}

export interface Draw {
  /** Absent on the older flow, which has no draw to refer back to. */
  readonly requestId: string | null
  readonly worker: string
  /** Uncompressed P-256 points, to seal a session key against. */
  readonly workerKey: string
  readonly disputerKey: string
}

/**
 * Which session flow a deployment speaks.
 *
 * These are not versions of one API so much as two different ones. On
 * `sortition` the service draws a worker and creates the session on chain
 * itself; on `classic` the caller picks up a signature and sends the
 * transaction. Guessing wrong produces a 404 halfway through, after a session
 * key has already been sealed.
 */
export type Flavour = 'sortition' | 'classic'

export interface Prepared {
  readonly worker: string
  /** The dispatcher's signature, for `createSession`. */
  readonly signature: string
  readonly expiry: bigint
}

export interface Session {
  readonly sessionId: string
  /** The service creates the session on chain itself, using the delegate. */
  readonly transactionHash: string
}

export class Api {
  readonly #url: string
  readonly #timeout: number
  #token: string | null = null
  #flavour: Flavour | null = null

  constructor(options: ApiOptions) {
    if (!/^https?:\/\//.test(options.url)) {
      throw new ApiError(`api url must be http or https, got ${JSON.stringify(options.url)}`, 0)
    }
    this.#url = options.url.replace(/\/$/, '')
    this.#timeout = options.timeout ?? 90_000
  }

  get authenticated(): boolean {
    return this.#token !== null
  }

  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.#token) headers.authorization = `Bearer ${this.#token}`

    let response
    try {
      // Raced rather than aborted: Bare has no AbortController.
      let timer: ReturnType<typeof setTimeout> | undefined
      response = await Promise.race([
        fetch(`${this.#url}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body)
        }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.#timeout)
        })
      ])
      clearTimeout(timer)
    } catch (err) {
      throw new ApiError(`${path}: could not reach the service — ${(err as Error).message}`, 0)
    }

    if (!response) {
      throw new ApiError(`${path}: no answer in ${Math.round(this.#timeout / 1000)}s`, 0)
    }

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new ApiError(
        `${path}: the service returned something that is not JSON`,
        response.status
      )
    }

    if (response.status >= 400) {
      const detail = parsed as { error?: string; message?: string }
      throw new ApiError(
        `${detail.message ?? detail.error ?? 'request failed'}`,
        response.status,
        detail.error ?? null
      )
    }

    return parsed as T
  }

  /**
   * Signs in by proving control of an address.
   *
   * The signature is EIP-191 over a SIWE message the service composes, so the
   * wallet needs no special support — the same call that signs a message
   * anywhere else does this.
   */
  async signIn(address: string, sign: (message: string) => string): Promise<void> {
    const challenge = await this.#send<{ message: string }>(
      'GET',
      `/api/auth/challenge?address=${address}`
    )
    if (!challenge?.message) {
      throw new ApiError('the service did not offer a message to sign', 0)
    }

    const verified = await this.#send<{ token?: string }>('POST', '/api/auth/verify', {
      message: challenge.message,
      signature: sign(challenge.message)
    })

    if (!verified.token) throw new ApiError('signing in produced no token', 0)
    this.#token = verified.token
  }

  signOut(): void {
    this.#token = null
  }

  async models(): Promise<readonly Model[]> {
    const body = await this.#send<{ models?: Model[] }>('GET', '/api/models')
    return body.models ?? []
  }

  async balance(): Promise<Balance> {
    const body = await this.#send<{
      balance: string
      delegate: string
      delegateAuthorized: boolean
    }>('GET', '/api/balance')

    return {
      balance: BigInt(body.balance ?? 0),
      delegate: body.delegate,
      delegateAuthorized: body.delegateAuthorized === true
    }
  }

  /**
   * Asks the network to draw a worker.
   *
   * Slow, and it fails by timing out where no worker is running that model —
   * which is a fact about the network rather than about the request, and worth
   * reporting as such.
   */
  async draw(modelId: string): Promise<Draw> {
    const body = await this.#send<{
      reqId: string
      worker: string
      workerEncryptionKey: string
      disputerEncryptionKey: string
    }>('POST', '/api/sessions/sortition/request', { modelId })

    if (!body.reqId) throw new ApiError('the draw returned no request id', 0)

    return {
      requestId: body.reqId,
      worker: body.worker,
      workerKey: body.workerEncryptionKey,
      disputerKey: body.disputerEncryptionKey
    }
  }

  /**
   * Which flow this deployment offers, asked once.
   *
   * Taken from the service's own published routes rather than probed by
   * attempting one and catching the 404 — a failed attempt at sortition still
   * costs a minute of waiting.
   */
  async flavour(): Promise<Flavour> {
    if (this.#flavour) return this.#flavour

    try {
      const spec = await this.#send<{ paths?: Record<string, unknown> }>('GET', '/docs/json')
      const routes = Object.keys(spec.paths ?? {})
      this.#flavour = routes.some((route) => route.includes('/sortition/'))
        ? 'sortition'
        : 'classic'
    } catch {
      // A deployment that will not describe itself is assumed to be the older
      // one, because that is the flow that fails cheaply.
      this.#flavour = 'classic'
    }

    return this.#flavour
  }

  /** Picks a worker, on deployments without sortition. Immediate, unlike a draw. */
  async select(modelId: string): Promise<Draw> {
    const body = await this.#send<{
      worker: string
      workerEncryptionKey: string
      disputerEncryptionKey: string
    }>('POST', '/api/sessions/select', { modelId })

    if (!body.worker) throw new ApiError('no worker was offered', 0)
    return {
      requestId: null,
      worker: body.worker,
      workerKey: body.workerEncryptionKey,
      disputerKey: body.disputerEncryptionKey
    }
  }

  /** Exchanges sealed keys for the dispatcher's signature, on the older flow. */
  async prepare(modelId: string, encWorkerKey: string, encDisputerKey: string): Promise<Prepared> {
    const body = await this.#send<{ worker: string; signature: string; expiry: number | string }>(
      'POST',
      '/api/sessions/prepare',
      { modelId, encWorkerKey, encDisputerKey }
    )

    if (!body.signature) throw new ApiError('the service returned no signature', 0)
    return { worker: body.worker, signature: body.signature, expiry: BigInt(body.expiry ?? 0) }
  }

  /** Hands over the sealed session keys; the service creates the session on chain. */
  async openSession(
    requestId: string,
    encWorkerKey: string,
    encDisputerKey: string
  ): Promise<Session> {
    const body = await this.#send<{ sessionId: string; txHash: string }>(
      'POST',
      `/api/sessions/sortition/${requestId}/keys`,
      { encWorkerKey, encDisputerKey }
    )

    if (!body.sessionId) throw new ApiError('no session was created', 0)
    return { sessionId: body.sessionId, transactionHash: body.txHash }
  }

  /**
   * The relay token for a session.
   *
   * Answers 202 until the session is confirmed on chain, so this waits rather
   * than treating "not yet" as "no".
   */
  async relayToken(sessionId: string, attempts = 30, interval = 2000): Promise<string> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const body = await this.#send<{ token?: string }>('GET', `/api/sessions/${sessionId}/token`)
      if (body.token) return body.token
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    throw new ApiError(`session ${sessionId} never became ready for the relay`, 0)
  }

  /** Uploads the encrypted prompt. The service pays for the blob transaction. */
  async putBlob(sessionId: string, ciphertext: string): Promise<string> {
    const body = await this.#send<{ blobHashes?: string[] }>('POST', '/api/blobs', {
      data: ciphertext,
      sessionId
    })

    const hash = body.blobHashes?.[0]
    if (!hash) throw new ApiError('the blob upload returned no hash', 0)
    return hash
  }

  /** Submits the job, paid from the prepaid balance by the delegate. */
  async submit(sessionId: string, blobHash: string): Promise<string> {
    const body = await this.#send<{ jobId: string }>(
      'POST',
      `/api/sessions/${sessionId}/messages`,
      {
        blobHash
      }
    )
    return body.jobId
  }
}
