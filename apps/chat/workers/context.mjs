/**
 * Everything the handlers are allowed to reach.
 *
 * The shape of this object is the worker's internal contract: every module under
 * `handlers/` destructures it, and the tests build one by hand. It is assembled
 * here, from the services, rather than closing over three dozen bindings in the
 * boot script.
 *
 * The mutable pieces are accessors rather than values. `network` and `rpc` are
 * both replaced when the network setting changes, and a handler that had
 * destructured either at startup would go on talking to the chain the process
 * booted on — silently, and only for some requests. A call is the signal that
 * the answer is read fresh.
 */

import { NETWORKS } from '@lcai-p2p/worker'

export function createContext({
  attachments,
  chain,
  chatDir,
  chatStore,
  guard,
  hosting,
  inference,
  poolFor,
  rooms,
  secrets,
  send,
  settings,
  swarm,
  useWalletInRooms,
  vault,
  wallet,
  workerConfig,
  handle
}) {
  return {
    attachmentsFor: attachments.open,
    forgetAttachments: attachments.forget,
    availability: hosting.availability,
    chatDir,
    chatStore,
    guard,
    host: hosting.host,
    poolFor,
    localState: secrets.localState,
    rooms,
    send,
    session: inference.session,
    swarm,
    wallet,
    vaultWrittenAt: vault.writtenAt,
    network: settings.network,
    /**
     * The chain this build expects, from the pinned profile rather than from the
     * node.
     *
     * The chain id is what stops a signed transaction being replayed elsewhere,
     * so asking the node for it means asking the one party with a reason to lie.
     * Everything that signs passes this, and `sendTransaction` refuses when the
     * node disagrees.
     */
    chainId: () => BigInt(NETWORKS[settings.network()].chainId),
    rpc: chain.rpc,
    settings: settings.values,
    forgetInference: inference.forget,
    inference: inference.api,
    reconnectChain: chain.reconnect,
    saveSettings: settings.save,
    setting: settings.setting,
    transcripts: inference.transcripts,
    useWalletInRooms,
    workerConfig,
    // The keystore password, sealed: an accessor for reading it (undefined while
    // the wallet is locked) and the adopting write, which seals it and strips
    // any plaintext copy from settings.
    workerKeystorePassword: secrets.keystorePassword,
    adoptWorkerPassword: secrets.adopt,
    // The dashboard reports balances, which the wallet already answers for. The
    // alternative is a second copy of that arithmetic, and two copies of a
    // balance is how a screen ends up disagreeing with itself.
    handle
  }
}
