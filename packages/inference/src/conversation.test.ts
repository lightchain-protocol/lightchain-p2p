import { beforeEach, describe, expect, it, vi } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  fromPrivateKey,
  hashDigestForSigning,
  toBytes,
  toHex,
  type Account,
  type Rpc
} from '@lcai-p2p/chain'
import { decryptSessionKey, encrypt, generateKeyPair } from '@lcai-p2p/inference-crypto'
import {
  Api,
  ApiError,
  Conversation,
  ConversationError,
  SignatureError,
  responseDigest
} from './index.js'

/**
 * A conversation, driven end to end through a relay that is not one.
 *
 * The socket module is the seam: the mock below hands back an object whose
 * `close` is real and whose handlers the tests call directly, playing the
 * relay. The session key never has to be stubbed — the worker half of the
 * exchange is played for real, unsealing the key the conversation sealed to
 * the drawn worker and encrypting frames with it, so what these tests check
 * is the protocol rather than a description of it.
 */

interface RelayHandlers {
  onMessage(frame: string): void
  onClose(): void
  onError(error: Error): void
}

const { relays } = vi.hoisted(() => ({
  relays: [] as { url: string; handlers: RelayHandlers; closed: boolean }[]
}))

vi.mock('../runtime/socket-node.js', () => ({
  connect: async (url: string, handlers: RelayHandlers) => {
    const relay = { url, handlers, closed: false }
    relays.push(relay)
    return {
      close: () => {
        relay.closed = true
      }
    }
  }
}))

const MODEL = { id: `0x${'ab'.repeat(32)}`, name: 'llama3-8b' }

/** The secp256k1 identity the worker signs answers with. */
const SIGNING_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const signer = fromPrivateKey(SIGNING_KEY)

/** What the signature check needs, matching the chain stub below. */
const CHAIN_ID = 9200
const JOB_REGISTRY = '0xfb15f90298e4ccd7106e76ffb5e520315cc42b0b'

function makeApi(over: Record<string, unknown> = {}) {
  /** The P-256 pair the worker opens sealed session keys with. */
  const workerEncryption = generateKeyPair()
  const mocks = {
    flavour: vi.fn(async () => 'sortition' as const),
    draw: vi.fn(async () => ({
      requestId: 'req-1',
      worker: signer.address,
      workerKey: toHex(workerEncryption.publicKey),
      disputerKey: toHex(generateKeyPair().publicKey)
    })),
    openSession: vi.fn<
      (
        requestId: string,
        encWorkerKey: string,
        encDisputerKey: string
      ) => Promise<{ sessionId: string; transactionHash: string }>
    >(async () => ({ sessionId: '3', transactionHash: '0xtx' })),
    relayToken: vi.fn(async () => 'relay-token'),
    putBlob: vi.fn(async () => `0x${'cd'.repeat(32)}`),
    submit: vi.fn(async () => '7'),
    ...over
  }
  return { api: mocks as unknown as Api, mocks, workerEncryption }
}

function makeConversation(api: Api, verify = false): Conversation {
  return new Conversation({
    api,
    relayUrl: 'wss://relay.example',
    model: MODEL,
    verify,
    ...(verify
      ? {
          chain: {
            rpc: {
              chainId: async () => CHAIN_ID,
              // `resolveAddresses` decodes the low twenty bytes of the word.
              call: async () => `0x${'00'.repeat(12)}${JOB_REGISTRY.slice(2)}`
            } as unknown as Rpc,
            account: {} as Account
          }
        }
      : {})
  })
}

/** The session key the conversation sealed to the worker, opened as the worker would. */
function sessionKeyFrom(
  mocks: ReturnType<typeof makeApi>['mocks'],
  workerEncryption: ReturnType<typeof generateKeyPair>,
  call = 0
): Uint8Array {
  const encWorkerKey = mocks.openSession.mock.calls[call]![1]
  return decryptSessionKey(toBytes(encWorkerKey), workerEncryption.secretKey)
}

/** A relay frame carrying `text`, encrypted under the session key. */
function frame(sessionKey: Uint8Array, text: string, over: Record<string, unknown> = {}): string {
  const ciphertext = encrypt(sessionKey, new TextEncoder().encode(text))
  return JSON.stringify({
    type: 'chunk',
    jobId: '7',
    seq: 0,
    payload: Buffer.from(ciphertext).toString('base64'),
    ...over
  })
}

/** The signature the assigned worker would put on a frame's ciphertext. */
function signed(ciphertextB64: string, jobId: bigint, sessionId: bigint): string {
  const digest = responseDigest({
    chainId: CHAIN_ID,
    jobRegistry: JOB_REGISTRY,
    jobId,
    sessionId,
    ciphertext: new Uint8Array(Buffer.from(ciphertextB64, 'base64'))
  })
  const recovered = secp256k1.sign(hashDigestForSigning(digest), toBytes(SIGNING_KEY), {
    prehash: false,
    format: 'recovered'
  })
  const out = new Uint8Array(65)
  out.set(recovered.slice(1), 0)
  out[64] = recovered[0] as number
  return toHex(out)
}

/** Waits until the job has been submitted, so frames sent after are this job's. */
async function untilSubmitted(mocks: ReturnType<typeof makeApi>['mocks'], times = 1) {
  await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(times))
}

beforeEach(() => {
  relays.length = 0
})

describe('starting', () => {
  it('refuses a second start while one is in flight', async () => {
    const { api, mocks } = makeApi({ draw: vi.fn(() => new Promise<never>(() => {})) })
    const conversation = makeConversation(api)

    const first = conversation.start()
    first.catch(() => {})

    await expect(conversation.start()).rejects.toThrow(/already being started/)
    expect(mocks.draw).toHaveBeenCalledTimes(1)
  })

  it('can be started again after a start that failed', async () => {
    const { api, mocks } = makeApi()
    mocks.draw.mockRejectedValueOnce(new ApiError('no answer in 90s', 0))
    const conversation = makeConversation(api)

    await expect(conversation.start()).rejects.toThrow(ConversationError)
    await conversation.start()

    expect(conversation.open).toBe(true)
    expect(conversation.sessionId).toBe('3')
  })
})

describe('a failed submit', () => {
  it('does not wedge the session: the next question still goes', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    mocks.putBlob.mockRejectedValueOnce(new ApiError('the blob store is down', 503))
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    await expect(conversation.ask('hi')).rejects.toThrow('the blob store is down')

    // Before the fix, this threw "a question is already waiting for an answer"
    // until the session was closed — the pending slot was never cleared.
    const asking = conversation.ask('hi again')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'fine', { type: 'complete' }))

    await expect(asking).resolves.toEqual({ jobId: '7', text: 'fine' })
  })

  it('rejects the question, not the session, when the relay closes mid-answer', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const asking = conversation.ask('hi')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onClose()

    await expect(asking).rejects.toThrow(/the relay closed/)

    // The socket is gone, so the conversation knows it is no longer open.
    expect(conversation.open).toBe(false)
    expect(() => sessionKeyFrom(mocks, workerEncryption)).not.toThrow()
    void sessionKey
  })
})

describe('chunks', () => {
  it('collapses the chunk a deployment sends twice', async () => {
    // Testnet streams a `chunk` and then repeats the last one as the payload
    // of `complete`. Keyed by sequence number, the repeat does not append.
    const { api, mocks, workerEncryption } = makeApi()
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const asking = conversation.ask('say ok')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'ok', { type: 'chunk', seq: 0 }))
    relays[0]!.handlers.onMessage(frame(sessionKey, 'ok', { type: 'complete', seq: 0 }))

    await expect(asking).resolves.toEqual({ jobId: '7', text: 'ok' })
  })

  it('refuses a frame the assigned worker did not sign', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    const conversation = makeConversation(api, true)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const asking = conversation.ask('hi')
    await untilSubmitted(mocks)
    // Correctly encrypted, correctly addressed — and unsigned, which a relay
    // substituting its own answer would be.
    relays[0]!.handlers.onMessage(frame(sessionKey, 'a lie', { type: 'chunk', seq: 0 }))

    await expect(asking).rejects.toThrow(SignatureError)

    // The refusal did not wedge the session either: a signed frame answers.
    const next = conversation.ask('hi again')
    await untilSubmitted(mocks, 2)
    const honest = frame(sessionKey, 'the truth', { type: 'complete', seq: 0, jobId: '7' })
    const payload = JSON.parse(honest) as { payload: string }
    relays[0]!.handlers.onMessage(
      JSON.stringify({ ...payload, signature: signed(payload.payload, 7n, 3n) })
    )

    await expect(next).resolves.toEqual({ jobId: '7', text: 'the truth' })
  })
})

describe('an answer that never comes', () => {
  it('stops collecting frames once the wait has timed out', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    mocks.submit.mockResolvedValueOnce('7').mockResolvedValueOnce('8')
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const asking = conversation.ask('slow', () => {}, 60)
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'half an answer', { seq: 0 }))

    await expect(asking).rejects.toThrow(/produced no answer/)

    // The late tail of the dead job: collected before the fix, and then
    // `commitment()` would have run against a partial answer.
    relays[0]!.handlers.onMessage(frame(sessionKey, 'late words', { seq: 1 }))
    relays[0]!.handlers.onMessage(JSON.stringify({ type: 'complete', jobId: '7' }))
    expect(conversation.evidence()).toBeNull()
    expect(conversation.answerFrames()).toBeNull()

    // And the next question starts clean rather than on the dead job's frames.
    const next = conversation.ask('next')
    await untilSubmitted(mocks, 2)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'fresh', { type: 'complete', jobId: '8' }))

    await expect(next).resolves.toEqual({ jobId: '8', text: 'fresh' })
  })
})

describe('a session the chain expired', () => {
  it('reopens and retries once rather than dying on SessionNotActive', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    mocks.submit
      .mockRejectedValueOnce(
        new ApiError(
          'submitJobOnBehalf failed: execution reverted with SessionNotActive(uint256)',
          500,
          'submit_failed'
        )
      )
      .mockResolvedValueOnce('8')
    mocks.openSession
      .mockResolvedValueOnce({ sessionId: '3', transactionHash: '0x1' })
      .mockResolvedValueOnce({ sessionId: '4', transactionHash: '0x2' })
    const conversation = makeConversation(api)
    await conversation.start()
    expect(conversation.sessionId).toBe('3')

    const asking = conversation.ask('are you still there')
    await untilSubmitted(mocks, 2)

    // A new session on a new socket, without the question noticing.
    expect(conversation.sessionId).toBe('4')
    expect(relays).toHaveLength(2)
    expect(relays[0]!.closed).toBe(true)

    // The old socket's close event arriving now must not kill the retried ask.
    relays[0]!.handlers.onClose()

    const newKey = sessionKeyFrom(mocks, workerEncryption, 1)
    relays[1]!.handlers.onMessage(frame(newKey, 'still here', { type: 'complete', jobId: '8' }))

    await expect(asking).resolves.toEqual({ jobId: '8', text: 'still here' })
  })

  it('only retries once: a second SessionNotActive is the answer', async () => {
    const { api, mocks } = makeApi()
    mocks.submit.mockRejectedValue(
      new ApiError('execution reverted with SessionNotActive(uint256)', 500, 'submit_failed')
    )
    const conversation = makeConversation(api)
    await conversation.start()

    await expect(conversation.ask('hi')).rejects.toThrow(/SessionNotActive/)
    expect(mocks.draw).toHaveBeenCalledTimes(2)
  })

  it('does not reopen for an ordinary failure', async () => {
    const { api, mocks } = makeApi()
    mocks.submit.mockRejectedValue(
      new ApiError('Deposit LCAI into JobRegistry first', 402, 'insufficient_balance')
    )
    const conversation = makeConversation(api)
    await conversation.start()

    await expect(conversation.ask('hi')).rejects.toThrow(/Deposit LCAI/)
    expect(mocks.draw).toHaveBeenCalledTimes(1)
  })
})

describe('the job lifecycle', () => {
  it('tracks a job from submitted to answered, with its refundable-from deadline', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    expect(conversation.jobs()).toEqual([])
    expect(conversation.job('7')).toBeNull()

    const asking = conversation.ask('hi')
    await untilSubmitted(mocks)

    // The moment the job exists on chain it is in the history, paid for
    // whatever happens next.
    const submitted = conversation.job('7')
    expect(submitted?.state).toBe('submitted')
    expect(submitted?.fee).toBeNull()
    // The deadline is the submission time plus the chain's response timeout —
    // ninety seconds from AIConfig.ackTimeout unless configured otherwise.
    expect(conversation.responseTimeout).toBe(90_000)
    expect(conversation.answerTimeout).toBe(180_000)
    expect(submitted!.deadline - submitted!.submittedAt).toBe(90_000)

    relays[0]!.handlers.onMessage(frame(sessionKey, 'hello', { type: 'complete' }))
    await expect(asking).resolves.toEqual({ jobId: '7', text: 'hello' })

    expect(conversation.job('7')?.state).toBe('answered')
    expect(conversation.jobs().map((entry) => entry.jobId)).toEqual(['7'])
  })

  it('marks a job timed-out - visibly refundable - when the wait expires', async () => {
    const { api } = makeApi()
    const conversation = makeConversation(api)
    await conversation.start()

    await expect(conversation.ask('slow', () => {}, 40)).rejects.toThrow(/produced no answer/)

    const tracked = conversation.job('7')
    expect(tracked?.state).toBe('timed-out')
    // Still paid for, with the deadline a claim can be argued from.
    expect(tracked!.deadline).toBeGreaterThan(tracked!.submittedAt)
    // No answer arrived, so there is no evidence — which is what makes the
    // job refundable rather than disputable.
    expect(conversation.evidenceFor('7')).toBeNull()
  })

  it('marks a job failed when the worker reports an error', async () => {
    const { api, mocks } = makeApi()
    const conversation = makeConversation(api)
    await conversation.start()

    const asking = conversation.ask('hi')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(
      JSON.stringify({ type: 'error', jobId: '7', error: 'the model crashed' })
    )

    await expect(asking).rejects.toThrow(/the model crashed/)
    expect(conversation.job('7')?.state).toBe('failed')
  })

  it('accumulates every job across asks, oldest first', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    mocks.submit.mockResolvedValueOnce('7').mockResolvedValueOnce('8')
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const first = conversation.ask('one')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'first', { type: 'complete', jobId: '7' }))
    await first

    const second = conversation.ask('two')
    await untilSubmitted(mocks, 2)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'second', { type: 'complete', jobId: '8' }))
    await second

    const jobs = conversation.jobs()
    expect(jobs.map((entry) => entry.jobId)).toEqual(['7', '8'])
    expect(jobs.map((entry) => entry.state)).toEqual(['answered', 'answered'])
  })

  it("keeps each job's evidence: a second ask does not clobber the first's", async () => {
    const { api, mocks, workerEncryption } = makeApi()
    mocks.submit.mockResolvedValueOnce('7').mockResolvedValueOnce('8')
    const conversation = makeConversation(api)
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const firstFrame = frame(sessionKey, 'first', { type: 'complete', jobId: '7' })
    const first = conversation.ask('one')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(firstFrame)
    await first

    const secondFrame = frame(sessionKey, 'second', { type: 'complete', jobId: '8' })
    const second = conversation.ask('two')
    await untilSubmitted(mocks, 2)
    relays[0]!.handlers.onMessage(secondFrame)
    await second

    const firstPayload = (JSON.parse(firstFrame) as { payload: string }).payload
    const secondPayload = (JSON.parse(secondFrame) as { payload: string }).payload

    const firstEvidence = conversation.evidenceFor('7')
    expect(firstEvidence?.ciphertext).toBe(firstPayload)
    expect(firstEvidence?.signatures).toEqual([''])
    expect(firstEvidence?.worker).toBe(signer.address)

    const secondEvidence = conversation.evidenceFor('8')
    expect(secondEvidence?.ciphertext).toBe(secondPayload)

    // The legacy latest-only form now describes the second job — and is null
    // here because these frames are unsigned, which is the rule it has
    // always had. The first job's proof survived the second ask either way.
    expect(conversation.evidence()).toBeNull()
    expect(conversation.evidenceFor('9')).toBeNull()
  })

  it('takes the answer wait and the chain deadline as options', async () => {
    const { api, mocks, workerEncryption } = makeApi()
    const conversation = new Conversation({
      api,
      relayUrl: 'wss://relay.example',
      model: MODEL,
      verify: false,
      answerTimeout: 5_000,
      responseTimeout: 120_000
    })
    await conversation.start()
    const sessionKey = sessionKeyFrom(mocks, workerEncryption)

    const asking = conversation.ask('hi')
    await untilSubmitted(mocks)
    relays[0]!.handlers.onMessage(frame(sessionKey, 'ok', { type: 'complete' }))
    await asking

    expect(conversation.answerTimeout).toBe(5_000)
    expect(conversation.responseTimeout).toBe(120_000)
    const tracked = conversation.job('7')
    expect(tracked!.deadline - tracked!.submittedAt).toBe(120_000)
  })
})
