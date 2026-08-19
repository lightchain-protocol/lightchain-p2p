import { Rpc, resolveAddresses } from '@lcai-p2p/chain'

/**
 * Fills in the two contract addresses by asking the registry for them.
 *
 * The registry answers for both in one round trip, so an operator supplying
 * them by hand was copying values that the chain already publishes — and a
 * stale copy points a worker at a contract nobody else is using.
 *
 * An address already set still wins. That is not a fallback so much as the
 * escape hatch for someone testing against a deployment the registry does not
 * know about, and it keeps every existing setup working unchanged.
 *
 * This lives apart from `worker.mjs` because that module reaches for `bare-os`
 * at import time, which only exists under Bare — putting the logic here is what
 * lets it be tested under Node at all.
 */
export async function withResolvedAddresses(config, rpc = null) {
  if (config.aiConfigAddress && config.jobRegistryAddress) return config

  const resolved = await resolveAddresses(
    rpc ?? new Rpc({ url: config.rpcUrl }),
    config.workerRegistryAddress
  )

  return {
    ...config,
    aiConfigAddress: config.aiConfigAddress ?? resolved.aiConfig,
    jobRegistryAddress: config.jobRegistryAddress ?? resolved.jobRegistry
  }
}
