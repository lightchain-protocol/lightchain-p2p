import ID from 'hypercore-id-encoding'
import { NETWORKS } from '@lcai-p2p/worker'

/**
 * Settings, read back alongside what they actually resolve to.
 *
 * The stored values on their own are close to useless to a reader: almost every
 * field is optional and falls through to an environment variable or a default
 * computed elsewhere, so a panel showing only what is stored shows an empty
 * form on a machine that is fully configured. Both halves are returned, and the
 * effective half is asked of the same code the worker uses rather than restated
 * here where it would drift.
 */
export function settingsHandlers(ctx) {
  const {
    availability,
    chatDir,
    forgetInference,
    network,
    reconnectChain,
    saveSettings,
    setting,
    settings,
    swarm,
    workerConfig
  } = ctx

  return {
    'settings.read': () => {
      const net = network()

      // resolveConfig refuses without a keystore password, which is exactly the
      // state someone is in when they first open this panel and most need to
      // see the defaults. So it is asked with a placeholder password purely to
      // learn them, rather than restating them here where they would drift.
      const { config } = workerConfig()
      const shown = config ?? workerConfig({ keystorePassword: 'unset' }).config

      return {
        // The password is never sent back, only whether one is set. Round
        // tripping a secret through a view to redisplay it is how they leak.
        values: { ...settings(), workerPassword: undefined },
        workerPasswordSet: Boolean(setting('workerPassword', 'WORKER_PASSWORD')),
        effective: {
          network: net,
          keysDir: shown.keysDir,
          containerName: shown.containerName,
          supportedModels: shown.supportedModels,
          ollamaUrl: shown.ollamaUrl,
          rpcUrl: NETWORKS[net].rpcUrl,
          chainId: NETWORKS[net].chainId
        },
        blindPeerCount: availability?.peerCount ?? 0,
        // The key a blind peer operator has to trust before it will announce
        // anything for us. Deliberately the DHT default key and not the swarm
        // key: they are different, and `blind-peering` connects with the former,
        // so trusting the latter silently produces a peer that stores rooms and
        // advertises none of them.
        dhtKey: ID.encode(swarm.dht.defaultKeyPair.publicKey),
        storage: chatDir
      }
    },

    'settings.write': (req) => {
      const patch = req.values && typeof req.values === 'object' ? req.values : {}
      // Undefined clears a value back to the environment or the default,
      // which is what an emptied field should mean.
      const next = { ...settings() }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') delete next[key]
        else next[key] = value
      }

      const before = network()
      saveSettings(next)

      // Only the network justifies tearing any of this down, and only when it
      // actually changed. A session's token, its worker and its prepaid balance
      // all belong to the chain it was opened on — but the theme and the
      // container name do not, and dropping a conversation someone has paid for
      // because they changed a preference is a bill for nothing.
      if (network() !== before) {
        reconnectChain()
        forgetInference()
      }

      return { ok: true }
    }
  }
}
