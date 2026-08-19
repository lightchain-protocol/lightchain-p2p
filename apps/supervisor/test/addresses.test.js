import { describe, expect, it } from 'vitest'
import { resolveConfig } from '@lcai-p2p/worker'
import { withResolvedAddresses } from '../lib/addresses.mjs'

const base = { network: 'testnet', keysDir: '/tmp/keys', keystorePassword: 'password' }

const BY_HAND = '0x1111111111111111111111111111111111111111'

// The registry answers `aiConfig()` and `jobRegistry()`; both return a 32-byte
// word with the address in the low 20. These are the real selectors — the first
// four bytes of keccak256 of each signature — so answering the wrong one here
// would be answering the wrong one on chain too.
const SELECTOR = { '0x85ff4862': 'aiConfig', '0x23682c47': 'jobRegistry' }

// The live values, so a fake that drifts from the deployment is visible.
const AI_CONFIG = '0xecf4ca5ba6d97ae586993e170764a1e92231b67e'
const JOB_REGISTRY = '0x531b3a87c5d785441b9cf55b98169f20fd9056a7'

function fakeRegistry({ onCall } = {}) {
  const calls = []
  return {
    calls,
    async call(request) {
      calls.push(request)
      onCall?.(request)

      const asked = SELECTOR[request.data.slice(0, 10)]
      if (!asked) throw new Error(`the registry was asked for ${request.data.slice(0, 10)}`)

      const answer = asked === 'aiConfig' ? AI_CONFIG : JOB_REGISTRY
      return `0x${'0'.repeat(24)}${answer.slice(2)}`
    }
  }
}

describe('resolving the contract addresses from the registry', () => {
  it('asks the registry when neither address is configured', async () => {
    const rpc = fakeRegistry()
    const out = await withResolvedAddresses(resolveConfig(base), rpc)

    // Named rather than merely different, because two addresses that are both
    // present and swapped is the failure this is actually guarding against.
    expect(out.aiConfigAddress).toBe(AI_CONFIG)
    expect(out.jobRegistryAddress).toBe(JOB_REGISTRY)
  })

  it('asks the registry it was given rather than one of its own', async () => {
    const rpc = fakeRegistry()
    const config = resolveConfig(base)
    await withResolvedAddresses(config, rpc)

    for (const request of rpc.calls) {
      expect(request.to).toBe(config.workerRegistryAddress)
    }
  })

  // The escape hatch for a deployment the registry does not know about. If a
  // configured address were overwritten, testing against a private deployment
  // would silently talk to the public one instead.
  it('leaves configured addresses alone and makes no call at all', async () => {
    const rpc = fakeRegistry()
    const config = resolveConfig({
      ...base,
      aiConfigAddress: BY_HAND,
      jobRegistryAddress: BY_HAND
    })

    const out = await withResolvedAddresses(config, rpc)

    expect(out.aiConfigAddress).toBe(BY_HAND)
    expect(out.jobRegistryAddress).toBe(BY_HAND)
    expect(rpc.calls).toHaveLength(0)
  })

  it('fills only the address that is missing', async () => {
    const rpc = fakeRegistry()
    const out = await withResolvedAddresses(
      resolveConfig({ ...base, aiConfigAddress: BY_HAND }),
      rpc
    )

    expect(out.aiConfigAddress).toBe(BY_HAND)
    expect(out.jobRegistryAddress).toBe(JOB_REGISTRY)
  })

  // A worker started against contracts nobody else is using takes jobs it
  // cannot settle, so an unreachable registry has to stop the start rather
  // than fall through to a default.
  it('propagates the failure when the registry cannot be reached', async () => {
    const rpc = fakeRegistry({
      onCall() {
        throw new Error('eth_call: could not reach http://127.0.0.1:1 — NETWORK_ERROR')
      }
    })

    await expect(withResolvedAddresses(resolveConfig(base), rpc)).rejects.toThrow(/NETWORK_ERROR/)
  })

  it('produces a config the worker will actually run', async () => {
    const { isRunnable } = await import('@lcai-p2p/worker')

    expect(isRunnable(resolveConfig(base))).toBe(false)
    expect(isRunnable(await withResolvedAddresses(resolveConfig(base), fakeRegistry()))).toBe(true)
  })
})
