import { describe, expect, it } from 'vitest'
import { LIGHTCHAIN_DEVNET, chainById } from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'
import { LIGHTCHAIN_DEVNET_CHAIN_ID, LIGHTCHAIN_TESTNET_CHAIN_ID } from '../workers/guard.mjs'
import { relayUrlFor } from '../workers/handlers/ai.mjs'
import { networkName } from '../workers/handlers/settings.mjs'

/**
 * The devnet contract, pinned end to end.
 *
 * The network profile and the chain registry entry live in packages; the
 * mapping, the guard's chain set and the relay refusal live in the worker.
 * Both sides are checked against each other here, because a drift between
 * them fails silently — a guard literal that no longer matches the profile's
 * chain id is a policy applied to a chain nobody is on.
 */

describe('the devnet profile', () => {
  it('is one of exactly three networks', () => {
    expect(Object.keys(NETWORKS).sort()).toEqual(['devnet', 'mainnet', 'testnet'])
  })

  it('carries the live endpoints and the devnet-v2 chain id', () => {
    expect(NETWORKS.devnet).toMatchObject({
      name: 'devnet',
      chainId: 48221,
      symbol: 'LCAI',
      rpcUrl: 'https://rpc.devnet-v2.lightchain.ai',
      beaconApiUrl: 'https://beacon.devnet-v2.lightchain.ai',
      consumerApiUrl: 'https://chat-api.devnet-v2.lightchain.ai'
    })
  })

  it('publishes no explorer and no relay', () => {
    // The absences that remain are what devnet's behaviour keys on: no
    // explorer link may be built, and no conversation may be started.
    expect(NETWORKS.devnet.explorerUrl).toBeNull()
    expect(NETWORKS.devnet.relayUrl).toBeUndefined()
  })

  it('can host a worker: the testnet image, and the consumer API as its gateway', () => {
    // Hosting is decided from the profile — an image and a gateway — not from
    // the network's name, so this pair is what makes the Earn page work on
    // devnet at all. The image is the testnet build deliberately: the worker
    // binary takes its whole configuration from the environment, so one
    // publication serves both. The gateway is devnet's consumer API, which
    // there fills both roles; `worker-gateway.devnet-v2` is NXDOMAIN.
    expect(NETWORKS.devnet.image).toBe(NETWORKS.testnet.image)
    expect(NETWORKS.devnet.workerGatewayUrl).toBe(NETWORKS.devnet.consumerApiUrl)
  })

  it('pins no contract addresses, like testnet - they resolve from the predeploy', () => {
    expect(NETWORKS.devnet.aiConfigAddress).toBeUndefined()
    expect(NETWORKS.devnet.jobRegistryAddress).toBeUndefined()
    expect(NETWORKS.testnet.aiConfigAddress).toBeUndefined()
    expect(NETWORKS.testnet.jobRegistryAddress).toBeUndefined()
  })
})

describe('the chain registry entry', () => {
  it('exists as a constant with the same posture as the testnet', () => {
    expect(LIGHTCHAIN_DEVNET.id).toBe(48221)
    expect(LIGHTCHAIN_DEVNET.rpcUrls).toEqual(['https://rpc.devnet-v2.lightchain.ai'])
  })

  it('stays out of chainById, so the profile URL is the whole endpoint list', () => {
    // reconnectChain builds devnet's pool as the profile's own URL followed by
    // whatever the registry knows — and the registry deliberately knows
    // nothing, so the list is exactly the profile's one live endpoint.
    expect(chainById(NETWORKS.devnet.chainId)).toBeNull()
    expect(chainById(NETWORKS.testnet.chainId)).toBeNull()
    expect(chainById(NETWORKS.mainnet.chainId)).not.toBeNull()
  })
})

describe('the worker-side mapping', () => {
  it('maps the network setting to all three names, defaulting to mainnet', () => {
    expect(networkName('mainnet')).toBe('mainnet')
    expect(networkName('testnet')).toBe('testnet')
    expect(networkName('devnet')).toBe('devnet')
    expect(networkName('nonsense')).toBe('mainnet')
    expect(networkName(undefined)).toBe('mainnet')
  })

  it("keeps the guard's chain literals in step with the profiles", () => {
    // guard.mjs repeats the ids on purpose — it depends on nothing that parses
    // the outside world — so this is the check that the repetition is true.
    expect(LIGHTCHAIN_TESTNET_CHAIN_ID).toBe(NETWORKS.testnet.chainId)
    expect(LIGHTCHAIN_DEVNET_CHAIN_ID).toBe(NETWORKS.devnet.chainId)
  })

  it('hands out the relay where one exists and refuses plainly where none does', () => {
    expect(relayUrlFor('mainnet')).toBe(NETWORKS.mainnet.relayUrl)
    expect(relayUrlFor('testnet')).toBe(NETWORKS.testnet.relayUrl)
    expect(() => relayUrlFor('devnet')).toThrow(
      /model conversations are not available on devnet yet/
    )
  })
})
