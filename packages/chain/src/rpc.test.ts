import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { Rpc, RpcError } from './index.js'

/**
 * A real HTTP server rather than a stubbed fetch.
 *
 * The transport is the part that meets the outside world, and most of what can
 * go wrong there is not a well-formed JSON-RPC error: a node returns 502 from a
 * proxy, or HTML from a captive portal, or nothing at all. A stub that always
 * returns tidy JSON tests none of it.
 */

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  // fetch keeps connections alive, and `close` waits for every one of them.
  // Without this the teardown hangs rather than the test failing.
  server.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  server = undefined
})

async function serve(handler: (body: unknown) => { status?: number; body: string }): Promise<Rpc> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Handlers that do not care about the request still get called.
      }
      const { status = 200, body } = handler(parsed)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
  })

  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return new Rpc({ url: `http://127.0.0.1:${port}`, timeout: 2000 })
}

const ok = (result: unknown) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })

describe('requests', () => {
  it('sends a well-formed JSON-RPC body', async () => {
    let seen: Record<string, unknown> = {}
    const rpc = await serve((body) => {
      seen = body as Record<string, unknown>
      return ok('0x2008')
    })

    expect(await rpc.chainId()).toBe(8200)
    expect(seen.jsonrpc).toBe('2.0')
    expect(seen.method).toBe('eth_chainId')
    expect(seen.params).toEqual([])
    expect(typeof seen.id).toBe('number')
  })

  it('reads quantities, including zero and very large ones', async () => {
    const rpc = await serve(() => ok('0x0'))
    expect(await rpc.blockNumber()).toBe(0n)

    const big = await serve(() => ok(`0x${'f'.repeat(64)}`))
    expect(await big.balanceOf('0x0000000000000000000000000000000000000001')).toBe(
      (1n << 256n) - 1n
    )
  })

  it('asks for the pending nonce, not the mined one', async () => {
    // Two transactions sent back to back need the second to see the first, and
    // "latest" does not include what is still in the mempool.
    let params: unknown[] = []
    const rpc = await serve((body) => {
      params = (body as { params: unknown[] }).params
      return ok('0x3')
    })

    await rpc.transactionCount('0x0000000000000000000000000000000000000001')
    expect(params[1]).toBe('pending')
  })
})

describe('failures', () => {
  it('surfaces the revert reason rather than just "execution reverted"', async () => {
    const reason =
      '0x08c379a0' + encodeAbiParameters([{ type: 'string' }], ['insufficient balance']).slice(2)

    const rpc = await serve(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: 3, message: 'execution reverted', data: reason }
      })
    }))

    await expect(
      rpc.call({ to: '0x0000000000000000000000000000000000001002', data: '0x85ff4862' })
    ).rejects.toThrow(/insufficient balance/)

    // And the reason is available on the error, not only inside its message.
    const error = await rpc
      .call({ to: '0x0000000000000000000000000000000000001002', data: '0x85ff4862' })
      .catch((err: RpcError) => err)
    expect((error as RpcError).reason).toBe('insufficient balance')
    expect((error as RpcError).code).toBe(3)
  })

  it('reports an HTTP failure as one', async () => {
    const rpc = await serve(() => ({ status: 502, body: 'gateway is unhappy' }))
    await expect(rpc.chainId()).rejects.toThrow(/HTTP 502/)
  })

  it('reports a body that is not JSON', async () => {
    // A captive portal or a misrouted proxy returns HTML with a 200.
    const rpc = await serve(() => ({ body: '<html>not a node</html>' }))
    await expect(rpc.chainId()).rejects.toThrow(/not JSON/)
  })

  it('reports a response with neither result nor error', async () => {
    const rpc = await serve(() => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1 }) }))
    await expect(rpc.chainId()).rejects.toThrow(/no result/)
  })

  it('gives up on a node that never answers', async () => {
    server = createServer(() => {
      // Accept and never respond, which is what a half-open connection looks
      // like and what would otherwise hang the worker forever.
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const rpc = new Rpc({ url: `http://127.0.0.1:${port}`, timeout: 300 })
    await expect(rpc.chainId()).rejects.toThrow(/did not answer in 300ms/)
  })

  it('reports an unreachable host', async () => {
    // Port 1 is reserved and nothing listens on it.
    const rpc = new Rpc({ url: 'http://127.0.0.1:1', timeout: 2000 })
    await expect(rpc.chainId()).rejects.toThrow(/could not reach/)
  })

  it('refuses a url that is not http', () => {
    expect(() => new Rpc({ url: 'wss://example.com' })).toThrow(RpcError)
    expect(() => new Rpc({ url: 'rpc.example.com' })).toThrow(/http or https/)
  })
})
