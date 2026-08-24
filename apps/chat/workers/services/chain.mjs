/**
 * The chain client, and the checks that decide whether a relayed answer is real.
 *
 * Both are replaced together whenever the network setting changes — an answer
 * proved against one registry proves nothing about another — so they are one
 * object rather than two module-level bindings that had to be reset in step.
 */

import { FailoverRpc, chainById, lightchainErrors, resolveAddresses } from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'

export function createChain({ network }) {
  let rpc = null

  /**
   * What checking a relayed model answer needs: the chain it was signed against
   * and the registry address inside the digest.
   *
   * Resolved in the background rather than awaited, because a room must open
   * whether or not an RPC is reachable. Until it lands, answers read as unproven,
   * which is the truthful state — nothing has been checked.
   */
  let answerChecks = null

  async function resolveAnswerChecks() {
    try {
      const [chainId, addresses] = await Promise.all([rpc.chainId(), resolveAddresses(rpc)])
      answerChecks = { chainId, jobRegistry: addresses.jobRegistry }
    } catch {
      answerChecks = null
    }
  }

  /**
   * Points the chain client at whichever network is configured now.
   *
   * Called at boot and again whenever the setting changes. Nothing derived from
   * the old chain survives it: an answer proved against one registry proves
   * nothing about another, so the checks are dropped and resolved again, and the
   * pool itself is rebuilt — a bench earned against one network's endpoints says
   * nothing about another's.
   *
   * Reads go through every endpoint the chain registry lists for the network,
   * failing over when one stops answering: a balance read that throws gets
   * swallowed somewhere upstream and renders as zero, and a user cannot tell an
   * outage from a theft. Broadcasts are the exception and go to the profile's
   * own endpoint once, never retried and never moved — `FailoverRpc` in
   * `@lcai-p2p/chain` holds that split, and its comment holds the why.
   */
  function reconnectChain() {
    const profile = NETWORKS[network()]
    const listed = chainById(profile.chainId)?.rpcUrls ?? []
    // The profile's endpoint leads whatever the registry knows, so the one place
    // a broadcast may go is always the endpoint the profile named.
    const urls = [profile.rpcUrl, ...listed.filter((url) => url !== profile.rpcUrl)]
    rpc = new FailoverRpc({
      urls,
      errors: lightchainErrors(),
      // A benched endpoint is a node that just failed somebody; silence here is
      // how an outage becomes a wrong number with no explanation.
      onBench: (url, err) =>
        console.error(`chain endpoint ${url} benched after failing:`, err.message)
    })
    answerChecks = null
    void resolveAnswerChecks()
  }

  return {
    rpc: () => rpc,
    reconnect: reconnectChain,
    answerChecks: () => answerChecks
  }
}
