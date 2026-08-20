import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fromPrivateKey } from '@lcai-p2p/chain'
import { Api, ApiError } from './index.js'

/**
 * A real server standing in for the service, so the states a happy run never
 * reaches — a draw that times out, a session that is not ready, a token that
 * expires — are exercised rather than argued about.
 */

// A real key, because sign-in now checks that the signature recovers to the
// address it claims — a stubbed signature no longer passes, which is the point.
const account = fromPrivateKey(`0x${'11'.repeat(32)}`)
const otherAccount = fromPrivateKey(`0x${'22'.repeat(32)}`)
const ADDRESS = account.address
const sign = (message: string) => account.signMessage(message)

/** A route that never answers, so the client's own timeout is what ends it. */
const HANGS = Symbol('hangs')

/**
 * A challenge in the shape the service composes (viem's createSiweMessage:
 * domain is the host, uri is the origin, no statement). `null` omits the
 * line, for the malformed cases.
 */
const siweMessage = (over: Record<string, string | null> = {}) => {
  const f: Record<string, string | null> = {
    domain: new URL(url).host,
    address: ADDRESS,
    uri: url,
    version: '1',
    chainId: '8200',
    nonce: 'a-real-nonce',
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 300_000).toISOString(),
    ...over
  }
  const head = `${f.domain} wants you to sign in with your Ethereum account:\n${f.address}\n\n`
  const lines = [`URI: ${f.uri}`, `Version: ${f.version}`, `Chain ID: ${f.chainId}`]
  if (f.nonce !== null) lines.push(`Nonce: ${f.nonce}`)
  lines.push(`Issued At: ${f.issuedAt}`)
  if (f.expirationTime !== null) lines.push(`Expiration Time: ${f.expirationTime}`)
  return head + lines.join('\n')
}

let server: Server
let url: string
let routes: Record<string, (body: unknown) => unknown>
let seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = []
let held: { destroy(): void }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const path = req.url ?? ''
      const body = raw === '' ? undefined : JSON.parse(raw)
      seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, body })

      const key = `${req.method} ${path.split('?')[0]}`
      const handler = routes[key]
      res.setHeader('content-type', 'application/json')

      if (!handler) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not_found', message: `no route for ${key}` }))
        return
      }

      try {
        const result = handler(body)
        // Held open deliberately, to reach the client's own timeout. Kept so it
        // can be released, or closing the server waits on it for half a minute.
        if (result === HANGS) {
          held.push(res)
          return
        }
        if (result === undefined) {
          res.statusCode = 204
          res.end('')
          return
        }
        const withStatus = result as { __status?: number }
        if (withStatus.__status) {
          res.statusCode = withStatus.__status
          const { __status, ...rest } = withStatus
          void __status
          res.end(JSON.stringify(rest))
          return
        }
        res.end(JSON.stringify(result))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'boom', message: (err as Error).message }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => {
  for (const response of held) response.destroy()
  held = []
  return new Promise<void>((resolve) => server.close(() => resolve()))
})

const happy = (over: Record<string, (body: unknown) => unknown> = {}) => ({
  'GET /api/auth/challenge': () => ({ message: siweMessage() }),
  'POST /api/auth/verify': () => ({ token: 'a-real-token' }),
  'GET /api/models': () => ({ models: [{ id: '0xabc', name: 'gemma4:e2b' }] }),
  'GET /api/balance': () => ({
    balance: '250000000000000000',
    delegate: '0xFDBa3B97BCc393682bf4D16A43E67B1E2059cAC8',
    delegateAuthorized: true
  }),
  'POST /api/sessions/sortition/request': () => ({
    reqId: '204',
    worker: '0x2880914D937A0ddeBbF7fDA4cd1982493FDcF042',
    workerEncryptionKey: '0x04' + 'aa'.repeat(64),
    disputerEncryptionKey: '0x04' + 'bb'.repeat(64)
  }),
  'POST /api/sessions/sortition/204/keys': () => ({ sessionId: '774', txHash: '0xdead' }),
  'GET /api/sessions/774/token': () => ({ token: 'relay-token' }),
  'POST /api/blobs': () => ({ blobHashes: ['0x01ab'] }),
  'POST /api/sessions/774/messages': () => ({ jobId: '1279' }),
  ...over
})

const signedIn = async () => {
  const api = new Api({ url })
  await api.signIn(ADDRESS, sign)
  return api
}

describe('signing in', () => {
  it('signs the message the service offers and keeps the token', async () => {
    routes = happy()
    seen = []

    const api = new Api({ url })
    expect(api.authenticated).toBe(false)
    await api.signIn(ADDRESS, sign)
    expect(api.authenticated).toBe(true)

    // The signature is over exactly what was offered, not over anything the
    // client composed itself — and it recovers to the address it claims.
    const verify = seen.find((call) => call.path === '/api/auth/verify')
    const message = (verify?.body as { message: string }).message
    expect(message).toContain('wants you to sign in with your Ethereum account:')
    expect((verify?.body as { signature: string }).signature).toBe(account.signMessage(message))
  })

  it('refuses to sign something that is not a sign-in challenge', async () => {
    routes = happy({
      'GET /api/auth/challenge': () => ({ message: 'service wants you to sign in\nNonce: abc' })
    })
    seen = []

    let asked = 0
    await expect(
      new Api({ url }).signIn(ADDRESS, (message) => {
        asked += 1
        return sign(message)
      })
    ).rejects.toThrow(/not a sign-in-with-ethereum message/)

    // Nothing was signed, and nothing was sent to be verified: a refusal that
    // still asked the key for a signature would be no refusal at all.
    expect(asked).toBe(0)
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('refuses a challenge naming a different service', async () => {
    routes = happy({
      'GET /api/auth/challenge': () => ({ message: siweMessage({ domain: 'evil.example' }) })
    })
    seen = []

    await expect(new Api({ url }).signIn(ADDRESS, sign)).rejects.toThrow(
      /for "evil\.example", but this service is/
    )
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('refuses a challenge addressed to a different account', async () => {
    const other = `0x${'33'.repeat(20)}`
    routes = happy({
      'GET /api/auth/challenge': () => ({ message: siweMessage({ address: other }) })
    })
    seen = []

    await expect(new Api({ url }).signIn(ADDRESS, sign)).rejects.toThrow(
      new RegExp(`addressed to ${other}, not to`)
    )
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('refuses a challenge that has already expired', async () => {
    routes = happy({
      'GET /api/auth/challenge': () => ({
        message: siweMessage({ expirationTime: new Date(Date.now() - 1000).toISOString() })
      })
    })
    seen = []

    await expect(new Api({ url }).signIn(ADDRESS, sign)).rejects.toThrow(/expired at/)
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('refuses a challenge with no nonce, because it does not parse as one', async () => {
    routes = happy({
      'GET /api/auth/challenge': () => ({ message: siweMessage({ nonce: null }) })
    })
    seen = []

    await expect(new Api({ url }).signIn(ADDRESS, sign)).rejects.toThrow(
      /not a sign-in-with-ethereum message/
    )
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('refuses a challenge for a different chain when the chain is pinned', async () => {
    routes = happy()
    seen = []

    await expect(new Api({ url, chainId: 9200n }).signIn(ADDRESS, sign)).rejects.toThrow(
      /for chain 8200, but this network is chain 9200/
    )
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('accepts the pinned chain when the challenge agrees', async () => {
    routes = happy()
    const api = new Api({ url, chainId: 8200n })
    await api.signIn(ADDRESS, sign)
    expect(api.authenticated).toBe(true)
  })

  it('refuses a signature that recovers to a different account', async () => {
    routes = happy()
    seen = []

    await expect(
      new Api({ url }).signIn(ADDRESS, (message) => otherAccount.signMessage(message))
    ).rejects.toThrow(/the wallet answered for a different account/)
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('refuses a signature that is not one', async () => {
    routes = happy()
    seen = []

    await expect(new Api({ url }).signIn(ADDRESS, () => '0x1234')).rejects.toThrow(
      /could not be checked/
    )
    expect(seen.some((call) => call.path === '/api/auth/verify')).toBe(false)
  })

  it('sends the token on every later call, and nothing before', async () => {
    routes = happy()
    seen = []

    const api = await signedIn()

    // The count first. This asserts that no call before sign-in carried a
    // token, and `every` over an empty array says that too — so without this
    // the strongest reading of a pass is "signing in made no requests".
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((call) => call.auth === undefined)).toBe(true)

    await api.models()
    expect(seen.at(-1)?.auth).toBe('Bearer a-real-token')
  })

  it('forgets the token on sign out', async () => {
    routes = happy()
    const api = await signedIn()
    api.signOut()
    expect(api.authenticated).toBe(false)
  })

  it('complains when there is no message to sign', async () => {
    routes = happy({ 'GET /api/auth/challenge': () => ({}) })
    await expect(new Api({ url }).signIn(ADDRESS, sign)).rejects.toThrow(/did not offer a message/)
  })

  it('complains when verification produces no token', async () => {
    routes = happy({ 'POST /api/auth/verify': () => ({ success: true }) })
    await expect(new Api({ url }).signIn(ADDRESS, sign)).rejects.toThrow(/produced no token/)
  })
})

describe('reading', () => {
  it('lists models', async () => {
    routes = happy()
    const models = await (await signedIn()).models()
    expect(models).toEqual([{ id: '0xabc', name: 'gemma4:e2b' }])
  })

  it('returns no models rather than failing when the service sends none', async () => {
    routes = happy({ 'GET /api/models': () => ({}) })
    expect(await (await signedIn()).models()).toEqual([])
  })

  it('reads the balance as a bigint, because wei does not fit in a number', async () => {
    routes = happy()
    const balance = await (await signedIn()).balance()
    expect(balance.balance).toBe(250_000_000_000_000_000n)
    expect(balance.delegateAuthorized).toBe(true)
  })
})

describe('drawing a worker', () => {
  it('returns the worker and the keys to seal against', async () => {
    routes = happy()
    const drawn = await (await signedIn()).draw('0xabc')
    expect(drawn.requestId).toBe('204')
    expect(drawn.workerKey.startsWith('0x04')).toBe(true)
  })

  it('surfaces the service asking for the delegate to be authorised', async () => {
    // The one error that stops everything, and the one worth reading exactly.
    routes = happy({
      'POST /api/sessions/sortition/request': () => ({
        __status: 403,
        error: 'delegate_not_authorized',
        message: 'Call JobRegistry.setDelegateAuthorization(delegate, true) first'
      })
    })

    await expect((await signedIn()).draw('0xabc')).rejects.toMatchObject({
      code: 'delegate_not_authorized',
      status: 403
    })
  })

  it('gives up on a draw that never answers', async () => {
    // A draw that hangs is the ordinary case where no worker is running the
    // model, so it has to be reachable in a test.
    routes = happy({ 'POST /api/sessions/sortition/request': () => HANGS })

    const api = new Api({ url, timeout: 150 })
    await api.signIn(ADDRESS, sign)
    await expect(api.draw('0xabc')).rejects.toThrow(/no answer in/)
  })
})

describe('opening a session', () => {
  it('hands over the sealed keys and reports what was created', async () => {
    routes = happy()
    const session = await (await signedIn()).openSession('204', '0xaa', '0xbb')
    expect(session).toEqual({ sessionId: '774', transactionHash: '0xdead' })
  })

  it('waits while the session is still being confirmed', async () => {
    let attempts = 0
    routes = happy({
      'GET /api/sessions/774/token': () => {
        attempts += 1
        return attempts < 3 ? { __status: 202, status: 'pending' } : { token: 'relay-token' }
      }
    })

    expect(await (await signedIn()).relayToken('774', 10, 5)).toBe('relay-token')
    expect(attempts).toBe(3)
  })

  it('stops waiting eventually rather than hanging', async () => {
    routes = happy({ 'GET /api/sessions/774/token': () => ({ status: 'pending' }) })
    await expect((await signedIn()).relayToken('774', 3, 5)).rejects.toThrow(/never became ready/)
  })
})

describe('submitting', () => {
  it('uploads a blob and submits the job', async () => {
    routes = happy()
    seen = []

    const api = await signedIn()
    const hash = await api.putBlob('774', 'Y2lwaGVy')
    expect(hash).toBe('0x01ab')

    // The prompt goes up as ciphertext with the session it belongs to, and
    // nothing else.
    const blob = seen.find((call) => call.path === '/api/blobs')
    expect(blob?.body).toEqual({ data: 'Y2lwaGVy', sessionId: '774' })

    expect(await api.submit('774', hash)).toBe('1279')
  })

  it('refuses to pretend a blob upload worked', async () => {
    routes = happy({ 'POST /api/blobs': () => ({ blobHashes: [] }) })
    await expect((await signedIn()).putBlob('774', 'x')).rejects.toThrow(/no hash/)
  })
})

describe('failures', () => {
  it('reports the service message rather than the status code', async () => {
    routes = happy({
      'GET /api/balance': () => ({ __status: 402, error: 'broke', message: 'not enough' })
    })
    await expect((await signedIn()).balance()).rejects.toThrow(/not enough/)
  })

  it('says so when the service is not there', async () => {
    const api = new Api({ url: 'http://127.0.0.1:1', timeout: 500 })
    await expect(api.signIn(ADDRESS, sign)).rejects.toThrow(/could not reach/)
  })

  it('refuses a url that is not one', () => {
    expect(() => new Api({ url: 'chat-api.testnet.lightchain.ai' })).toThrow(ApiError)
  })
})
