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
/**
 * Settings the interface is allowed to change.
 *
 * Every one of these has a control behind it. The list is deliberately closed
 * rather than open: the worker reads a dozen settings and only these are ones a
 * person sets from the app, so anything else arriving here is either a typo or
 * something that should not be asking.
 */
const WRITABLE = new Set([
  // Appearance, written by the window itself
  'theme',
  'sidebar',
  // Three settings are deliberately absent from this list, and all three decide
  // what it costs to move money.
  //
  // `reauthAboveWei` and `confirmAboveWei` are the thresholds above which a
  // transfer needs the password again and a confirmation the operating system
  // draws. A window able to write them could raise both and then send anything
  // with neither check firing — which would make the guard a setting the
  // attacker configures. They are read from the settings file, so somebody can
  // still change them deliberately with an editor; what they are not is
  // reachable from the thing being guarded against.
  //
  // `autoLockMinutes` is absent for a second reason as well: the live wallet
  // holds the timeout too, so a write reaching only the file would look
  // accepted and take effect nowhere. It has a handler of its own.
  // Network and availability
  'network',
  'blindPeers',
  'hostRooms',
  'hostTrusted',
  'hostBudgetMb',
  // Two more are absent, and they are host arguments rather than settings.
  //
  // `keysDir` becomes the source of a `-v <dir>:/data` bind mount into a
  // container that runs as root, so a window that could write it could mount
  // any directory on this machine into the worker. `containerName` becomes the
  // subject of `docker logs` and `docker rm -f`, so a window that could write
  // it could read another container's log output — credentials included — or
  // destroy any container on the host. Neither needs an attack on Docker
  // itself; both are ordinary Docker doing exactly what the argument says.
  //
  // They stay settable with an editor, like the transfer thresholds above. What
  // they stop being is reachable from the untrusted side.
  // The worker this machine can run
  'workerPassword',
  'supportedModels',
  'ollamaUrl'
])

export function settingsHandlers(ctx) {
  const {
    availability,
    chatDir,
    forgetInference,
    host,
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
        storage: chatDir,
        // What this machine is holding for other people, if it is. Somebody who
        // has agreed to store strangers' data is owed a number rather than a
        // reassurance, and without one the feature is a black box that quietly
        // consumes a disk.
        hosting: host
          ? {
              on: true,
              key: ID.encode(host.peer.publicKey),
              heldBytes: Number(host.peer.digest?.bytesAllocated ?? 0),
              budgetBytes: Number(host.peer.maxBytes ?? 0),
              cores: Number(host.peer.digest?.cores ?? 0),
              evicting: Boolean(host.peer.needsGc?.())
            }
          : { on: false }
      }
    },

    'settings.write': (req) => {
      const patch = req.values && typeof req.values === 'object' ? req.values : {}

      const next = { ...settings() }
      for (const [key, value] of Object.entries(patch)) {
        // Named keys only. This handler took whatever it was given, and what it
        // was given comes from a window whose whole job is rendering text
        // written by strangers. Anything that got script running there could
        // repoint the chain addresses, clear the worker's keystore password, or
        // aim keysDir somewhere else entirely — none of which is an injection
        // bug, all of which is a capability nobody meant to hand over.
        if (!WRITABLE.has(key)) {
          throw new Error(`${key} is not a setting this app writes`)
        }

        // A value must be a string. An object here would be written into
        // settings.json and read back later by code expecting text, which is a
        // crash at the next boot rather than at the call that caused it.
        if (value !== null && typeof value !== 'string') {
          throw new Error(`${key} has to be text`)
        }

        // Undefined clears a value back to the environment or the default,
        // which is what an emptied field should mean.
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
