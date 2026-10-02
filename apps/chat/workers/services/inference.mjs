/**
 * The consumer API and the transcript log, both bound to one account.
 *
 * Held across requests because signing in costs a round trip and a signature,
 * and dropped together whenever the wallet locks or the network changes. Four
 * mutable bindings tracked that — they lived at module scope in `main.mjs`,
 * where anything could reset one and leave the other three stale.
 */

import b4a from 'b4a'
import { keccak256, toBytes } from '@lcai-p2p/chain'
import { Api, History } from '@lcai-p2p/inference'
import { NETWORKS } from '@lcai-p2p/worker'

/**
 * The transcript log, encrypted under a key only this wallet can derive.
 *
 * The key is a signature over a fixed string rather than anything stored: it is
 * deterministic for one account and unobtainable without it, so history belongs
 * to an identity and a locked wallet cannot read its own. Restoring a different
 * phrase leaves the old transcripts closed rather than lost — which is the
 * honest behaviour, since they were never that identity's to read.
 */
const HISTORY_KEY_MESSAGE = 'lightchain-hub: transcript encryption key, v1'

export function createInference({ wallet, chatStore, network }) {
  /**
   * The consumer API, signed in.
   *
   * Held across requests because signing in costs a round trip and a signature,
   * and dropped whenever the wallet locks or the network changes — a token is
   * bound to both, and reusing one across either is a confusing 401.
   */
  let api = null
  let apiFor = null
  let history = null
  let historyFor = null

  /**
   * The conversation currently open, if there is one.
   *
   * A holder rather than two variables in the inference handlers, because locking
   * the wallet and changing the network both have to end a conversation and
   * neither of those arrives as an inference request.
   */
  const session = { conversation: null, id: null }

  async function transcripts() {
    const account = wallet.account()
    if (history && historyFor === account.address) return history

    const key = keccak256(toBytes(account.signMessage(HISTORY_KEY_MESSAGE)))
    const core = chatStore.get({ name: `history:${account.address}`, encryptionKey: b4a.from(key) })
    await core.ready()

    history = new History({
      async append(record) {
        await core.append(b4a.from(JSON.stringify(record)))
      },
      async read() {
        const out = []
        for (let i = 0; i < core.length; i++) {
          try {
            out.push(JSON.parse(b4a.toString(await core.get(i))))
          } catch {
            // A block that will not parse is skipped rather than allowed to
            // wedge the whole transcript list.
          }
        }
        return out
      }
    })
    historyFor = account.address
    return history
  }

  async function api_() {
    const account = wallet.account()
    const identity = `${network()}:${account.address}`

    if (api && apiFor === identity) return api

    const next = new Api({
      url: NETWORKS[network()].consumerApiUrl,
      signInDomains: NETWORKS[network()].consumerSignInDomains ?? [],
      chainId: BigInt(NETWORKS[network()].chainId)
    })
    await next.signIn(account.address, (message) => account.signMessage(message))

    api = next
    apiFor = identity
    return api
  }

  function forgetInference() {
    session.conversation?.close()
    session.conversation = null
    session.id = null
    api = null
    apiFor = null
    history = null
    historyFor = null
  }

  return { session, transcripts, api: api_, forget: forgetInference }
}
