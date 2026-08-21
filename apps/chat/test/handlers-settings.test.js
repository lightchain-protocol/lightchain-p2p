import { describe, expect, it, vi } from 'vitest'
import ID from 'hypercore-id-encoding'
import { NETWORKS } from '@lcai-p2p/worker'
import { networkName, settingsHandlers } from '../workers/handlers/settings.mjs'

/**
 * The settings handler's boundary tests.
 *
 * The writable list is closed on purpose: everything arriving here comes from
 * a window whose whole job is rendering text written by strangers, and the
 * keys that are absent — the transfer-confirmation threshold, the keysDir bind
 * mount, the container name, the worker's keystore password — are absent
 * because a window able to write them would be configuring the thing that
 * guards against it. Those refusals, the string-only rule, and the network
 * change that is the only write allowed to tear down paid-for state are what
 * this suite pins.
 */

const DHT_KEY = Uint8Array.from({ length: 32 }, () => 9)

const CONFIG = {
  keysDir: '/keys',
  containerName: 'lightchain-worker',
  supportedModels: ['llama3-8b'],
  ollamaUrl: 'http://localhost:11434'
}

function ctxWith({ stored = {}, password = undefined, host = null, net = 'mainnet' } = {}) {
  // The live settings document and the network it resolves to, so a write can
  // actually change what network() answers — the only write allowed to tear
  // anything down.
  let current = { network: net, ...stored }

  const calls = {
    saved: [],
    receipts: [],
    reconnected: 0,
    forgot: 0
  }

  const workerConfig = vi.fn((overrides = {}) => ({
    // resolveConfig refuses without a keystore password; the panel still needs
    // the defaults, so a missing one is reported rather than invented.
    config: overrides.keystorePassword === undefined ? null : { ...CONFIG, ...overrides },
    problem: overrides.keystorePassword === undefined ? 'keystorePassword is required' : null
  }))

  const ctx = {
    availability: { peerCount: 2 },
    chatDir: '/chat',
    forgetInference: () => {
      calls.forgot += 1
    },
    host,
    // Mapped the way main.mjs maps it: an unrecognised stored value resolves
    // to mainnet, so writing one is not a network change and tears nothing down.
    network: () => networkName(current.network),
    reconnectChain: () => {
      calls.reconnected += 1
    },
    rooms: { setReceipts: vi.fn((on) => calls.receipts.push(on)) },
    saveSettings: (next) => {
      calls.saved.push(next)
      current = next
    },
    settings: () => ({ ...current }),
    swarm: { dht: { defaultKeyPair: { publicKey: DHT_KEY } } },
    workerConfig,
    workerKeystorePassword: () => password
  }

  return { ctx, calls, workerConfig }
}

describe('settings.read', () => {
  it('resolves the effective chain for each of the three networks', () => {
    // The panel's effective block is keyed by the same mapping the worker
    // boots with, so devnet must come back as devnet — chain id, RPC and all.
    const { ctx } = ctxWith({ net: 'devnet' })

    const read = settingsHandlers(ctx)['settings.read']()

    expect(read.effective.network).toBe('devnet')
    expect(read.effective.rpcUrl).toBe(NETWORKS.devnet.rpcUrl)
    expect(read.effective.chainId).toBe(NETWORKS.devnet.chainId)
  })

  it('never returns the stored worker password, only whether one is set', () => {
    const { ctx } = ctxWith({
      stored: { theme: 'dark', workerPassword: 'SEALED-ELSEWHERE' },
      password: 'the-sealed-one'
    })

    const read = settingsHandlers(ctx)['settings.read']()

    expect(read.values.theme).toBe('dark')
    expect(read.values.workerPassword).toBeUndefined()
    expect(read.workerPasswordSet).toBe(true)
    expect(JSON.stringify(read.values)).not.toContain('SEALED-ELSEWHERE')
  })

  it('reports the password unset when the sealed store has none', () => {
    const { ctx } = ctxWith()
    expect(settingsHandlers(ctx)['settings.read']().workerPasswordSet).toBe(false)
  })

  it('asks for the defaults with a placeholder password rather than restating them', () => {
    // resolveConfig refuses without a keystore password, which is exactly the
    // state someone is in when they first open this panel. The read must reach
    // for the placeholder rather than duplicate the defaults here.
    const { ctx, workerConfig } = ctxWith()

    const read = settingsHandlers(ctx)['settings.read']()

    expect(workerConfig).toHaveBeenCalledWith()
    expect(workerConfig).toHaveBeenCalledWith({ keystorePassword: 'unset' })
    expect(read.effective).toEqual({
      network: 'mainnet',
      keysDir: CONFIG.keysDir,
      containerName: CONFIG.containerName,
      supportedModels: CONFIG.supportedModels,
      ollamaUrl: CONFIG.ollamaUrl,
      rpcUrl: NETWORKS.mainnet.rpcUrl,
      chainId: NETWORKS.mainnet.chainId
    })
  })

  it('reports hosting as off when this machine stores nothing for others', () => {
    const { ctx } = ctxWith()

    const read = settingsHandlers(ctx)['settings.read']()

    expect(read.hosting).toEqual({ on: false })
    expect(read.blindPeerCount).toBe(2)
    expect(read.dhtKey).toBe(ID.encode(DHT_KEY))
    expect(read.storage).toBe('/chat')
  })

  it('reports what hosting holds in numbers when it is on', () => {
    // Somebody who agreed to store strangers' data is owed a number rather
    // than a reassurance.
    const host = {
      peer: {
        publicKey: DHT_KEY,
        digest: { bytesAllocated: 12_345n, cores: 4n },
        maxBytes: 1_000_000n,
        needsGc: () => false
      }
    }
    const { ctx } = ctxWith({ host })

    const read = settingsHandlers(ctx)['settings.read']()

    expect(read.hosting).toEqual({
      on: true,
      key: ID.encode(DHT_KEY),
      heldBytes: 12_345,
      budgetBytes: 1_000_000,
      cores: 4,
      evicting: false
    })
  })
})

describe('settings.write, the closed list', () => {
  it('refuses the settings that decide what it costs to move money', () => {
    // A window able to raise confirmAboveWei could then send anything with
    // the guard never firing — the guard would be a setting the attacker
    // configures. Both thresholds stay writable by an editor, not by the app.
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    for (const key of ['confirmAboveWei', 'reauthAboveWei', 'autoLockMinutes']) {
      expect(() => handlers['settings.write']({ values: { [key]: '0' } })).toThrow(
        `${key} is not a setting this app writes`
      )
    }
    expect(calls.saved).toEqual([])
  })

  it('refuses the host arguments that become Docker doing exactly what they say', () => {
    // keysDir becomes a root bind mount; containerName becomes the subject of
    // docker logs and docker rm -f. Neither is reachable from the window.
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    for (const key of ['keysDir', 'containerName']) {
      expect(() => handlers['settings.write']({ values: { [key]: '/etc' } })).toThrow(
        `${key} is not a setting this app writes`
      )
    }
    expect(calls.saved).toEqual([])
  })

  it('refuses the worker keystore password, which no window ever writes', () => {
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    expect(() =>
      handlers['settings.write']({ values: { workerPassword: 'hunter2' } })
    ).toThrow('workerPassword is not a setting this app writes')
    expect(calls.saved).toEqual([])
  })

  it('refuses a key it has never heard of, which is a typo or worse', () => {
    const { ctx, calls } = ctxWith()

    expect(() => settingsHandlers(ctx)['settings.write']({ values: { rpcUrl: 'http://evil' } })).toThrow(
      'rpcUrl is not a setting this app writes'
    )
    expect(calls.saved).toEqual([])
  })

  it('refuses a value that is not text, rather than crashing the next boot', () => {
    const { ctx, calls } = ctxWith()

    expect(() => settingsHandlers(ctx)['settings.write']({ values: { theme: { dark: true } } })).toThrow(
      'theme has to be text'
    )
    expect(calls.saved).toEqual([])
  })

  it('writes a writable key and clears one on null or empty', () => {
    const { ctx, calls } = ctxWith({ stored: { sidebar: 'wide' } })

    const reply = settingsHandlers(ctx)['settings.write']({
      values: { theme: 'dark', sidebar: '', hostRooms: null }
    })

    expect(reply).toEqual({ ok: true })
    expect(calls.saved).toHaveLength(1)
    expect(calls.saved[0].theme).toBe('dark')
    expect('sidebar' in calls.saved[0]).toBe(false)
    expect('hostRooms' in calls.saved[0]).toBe(false)
  })

  it('applies a receipts change to every open room the moment it is saved', () => {
    // A privacy switch that waited for a restart would keep telling rooms
    // something its owner believes they have stopped saying.
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    handlers['settings.write']({ values: { receipts: 'true' } })
    handlers['settings.write']({ values: { receipts: null } })

    expect(calls.receipts).toEqual([true, false])
  })

  it('does not touch receipts when the patch does not mention them', () => {
    const { ctx, calls } = ctxWith()

    settingsHandlers(ctx)['settings.write']({ values: { theme: 'dark' } })

    expect(calls.receipts).toEqual([])
  })

  it('tears down chain-side state only when the network actually changed', () => {
    // A session's token, its worker and its prepaid balance belong to the
    // chain they were opened on; the theme does not, and dropping a paid-for
    // conversation over a preference is a bill for nothing.
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    handlers['settings.write']({ values: { theme: 'dark' } })
    expect(calls.reconnected).toBe(0)
    expect(calls.forgot).toBe(0)

    handlers['settings.write']({ values: { network: 'testnet' } })
    expect(calls.reconnected).toBe(1)
    expect(calls.forgot).toBe(1)
  })

  it('accepts devnet and tears down exactly as a mainnet-to-testnet switch does', () => {
    // The Sprint 3 teardown — reconnect the chain client, forget the
    // inference session — is keyed by the network actually changing, and
    // devnet has to trip it like any other switch or the worker would go on
    // talking to the chain it booted on.
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    handlers['settings.write']({ values: { network: 'devnet' } })
    expect(calls.reconnected).toBe(1)
    expect(calls.forgot).toBe(1)

    // And back again: the switch is symmetric, not a one-way door.
    handlers['settings.write']({ values: { network: 'mainnet' } })
    expect(calls.reconnected).toBe(2)
    expect(calls.forgot).toBe(2)
  })

  it('maps an unrecognised network value to mainnet rather than crashing later', () => {
    // A hand-edited settings file, or a network a newer build retired, must
    // land somewhere safe. Writing it does not tear anything down, because
    // the resolved network never left mainnet.
    expect(networkName('devnet')).toBe('devnet')
    expect(networkName('testnet')).toBe('testnet')
    expect(networkName('mainnet')).toBe('mainnet')
    for (const bad of ['devnet2', '', 'MAINNET', 'constructor', undefined]) {
      expect(networkName(bad)).toBe('mainnet')
    }

    const { ctx, calls } = ctxWith()
    settingsHandlers(ctx)['settings.write']({ values: { network: 'nonsense' } })
    expect(calls.reconnected).toBe(0)
    expect(calls.forgot).toBe(0)
  })

  it('treats an absent or malformed patch as no change at all', () => {
    const { ctx, calls } = ctxWith()
    const handlers = settingsHandlers(ctx)

    expect(handlers['settings.write']({})).toEqual({ ok: true })
    expect(handlers['settings.write']({ values: 'everything' })).toEqual({ ok: true })
    expect(calls.saved).toHaveLength(2)
    expect(calls.reconnected).toBe(0)
  })
})
