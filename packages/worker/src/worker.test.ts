import { describe, expect, it } from 'vitest'
import { encodeCall } from '@lcai-p2p/chain'
import {
  KeystoreError,
  NETWORKS,
  WORKER_REGISTRY_ADDRESS,
  WorkerConfigError,
  containerKeystorePath,
  defaultOllamaUrl,
  inspectConfig,
  inspectWorker,
  keystoreFileName,
  logsWorker,
  selectKeystore,
  generateEncryptionKey,
  isHealthy,
  isRunnable,
  parseContainerState,
  pullImage,
  register,
  resolveConfig,
  resolveContractAddresses,
  runWorker,
  stopWorker,
  nearestOfferedModel,
  unwhitelistedModels
} from './index.js'

const PASSWORD = 'correct-horse-battery-staple'
const PRIVKEY = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

const base = {
  keysDir: '/home/op/lightchain-worker/keys',
  keystorePassword: PASSWORD,
  aiConfigAddress: '0x24D11533C354092ed6E18b964257819cE78Ce77D',
  jobRegistryAddress: '0xfB15F90298e4CcD7106E76fFB5e520315cC42B0b'
}

const config = resolveConfig(base)

describe('configuration', () => {
  it('defaults to mainnet with matching chain id and image', () => {
    expect(config.network).toBe('mainnet')
    expect(config.chainId).toBe(9200)
    expect(config.image).toContain('lightchain-mainnet-public-docker')
  })

  it('keeps chain id and image consistent on testnet', () => {
    // Mixing a testnet image with mainnet RPC produces a container that starts,
    // connects, and then misbehaves in ways that look like a protocol fault.
    const testnet = resolveConfig({ ...base, network: 'testnet' })
    expect(testnet.chainId).toBe(8200)
    expect(testnet.image).toContain('lightchain-testnet-public-docker')
    expect(testnet.rpcUrl).toBe(NETWORKS.testnet.rpcUrl)
  })

  it('requires a keystore password rather than accepting the placeholder gap', () => {
    expect(() => resolveConfig({ ...base, keystorePassword: '' })).toThrow(/cannot be unlocked/)
  })

  it('accepts the colon-bearing names the network actually publishes', () => {
    // The regression this exists for. A rule that rejected any colon was
    // written when mainnet published only llama3-8b and llama3-70b; the
    // upgrade added four names that carry one, and every one of them became
    // unconfigurable. These are the live mainnet names, and keccak256 of each
    // — colon included — is the whitelisted id on chain.
    const models = ['gemma4:e2b', 'gpt-oss:20b', 'qwen3-vl:8b', 'gpt-oss:120b']
    expect(resolveConfig({ ...base, supportedModels: models }).supportedModels).toEqual(models)
  })

  it('rejects a name with whitespace, which would hash to nothing on chain', () => {
    expect(() => resolveConfig({ ...base, supportedModels: ['llama3 8b'] })).toThrow(/whitespace/)
  })

  it('rejects the same model twice', () => {
    expect(() => resolveConfig({ ...base, supportedModels: ['llama3-8b', 'llama3-8b'] })).toThrow(
      /listed twice/
    )
  })

  it('rejects a malformed contract address', () => {
    expect(() => resolveConfig({ ...base, aiConfigAddress: '0x123' })).toThrow(WorkerConfigError)
  })

  it('defaults the mainnet contract addresses to the published proxies', () => {
    // Registering with nothing configured must work out of the box. These are
    // the proxy addresses from
    // https://docs.lightchain.ai/docs/getting-started/mainnet/contracts —
    // never the implementations, which governance can swap behind the proxy.
    const bare = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD })
    expect(bare.aiConfigAddress).toBe('0x24D11533C354092ed6E18b964257819cE78Ce77D')
    expect(bare.jobRegistryAddress).toBe('0xfB15F90298e4CcD7106E76ffB5e520315cC42B0b')
    expect(bare.workerRegistryAddress).toBe('0x0000000000000000000000000000000000001002')
    expect(isRunnable(bare)).toBe(true)
  })

  it('lets an explicit address win over the profile default', () => {
    // The escape hatch for testing against a deployment the profile predates.
    const override = '0x0000000000000000000000000000000000000001'
    const custom = resolveConfig({
      keysDir: '/k',
      keystorePassword: PASSWORD,
      aiConfigAddress: override
    })
    expect(custom.aiConfigAddress).toBe(override)
    expect(custom.jobRegistryAddress).toBe(NETWORKS.mainnet.jobRegistryAddress)
  })

  it('keeps testnet resolving from the registry rather than a baked-in copy', () => {
    // A stale hardcoded testnet address points a worker at a contract nobody
    // else is using, so the profile deliberately carries none.
    expect(NETWORKS.testnet.aiConfigAddress).toBeUndefined()
    expect(NETWORKS.testnet.jobRegistryAddress).toBeUndefined()

    const partial = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'testnet' })
    expect(partial.aiConfigAddress).toBeUndefined()
    expect(partial.jobRegistryAddress).toBeUndefined()
    expect(isRunnable(partial)).toBe(false)
    expect(isRunnable(config)).toBe(true)
  })
})

describe('the devnet profile', () => {
  it('is pinned to the probed devnet endpoints', () => {
    // Verified live against the devnet: chain id 48221 (0xbc5d), with the RPC,
    // beacon and consumer API answering. The worker gateway, relay and
    // explorer hostnames are NXDOMAIN, so the profile carries none of them.
    const devnet = NETWORKS.devnet
    expect(devnet.name).toBe('devnet')
    expect(devnet.chainId).toBe(48221)
    expect(devnet.symbol).toBe('LCAI')
    expect(devnet.decimals).toBe(18)
    expect(devnet.rpcUrl).toBe('https://rpc.devnet-v2.lightchain.ai')
    expect(devnet.beaconApiUrl).toBe('https://beacon.devnet-v2.lightchain.ai')
    expect(devnet.consumerApiUrl).toBe('https://chat-api.devnet-v2.lightchain.ai')
    expect(devnet.explorerUrl).toBeNull()
    // Devnet consolidates the worker gateway into its consumer API; the
    // worker-gateway hostname the other networks use is NXDOMAIN here.
    expect(devnet.workerGatewayUrl).toBe('https://chat-api.devnet-v2.lightchain.ai')
    expect(devnet.workerGatewayUrl).toBe(devnet.consumerApiUrl)
    expect(devnet.relayUrl).toBeUndefined()
    // The image is the one exception, and it is the testnet build on purpose.
    // The binary is configured entirely by environment — pointed at devnet's
    // RPC it loads its config and reaches the keystore step exactly as it does
    // for its own network — so hosting here needs no separate publication.
    // Without this the profile has no image and `requireImage` refuses every
    // docker verb, which is what made devnet unusable for a worker at all.
    expect(devnet.image).toBe(NETWORKS.testnet.image)
    // No pinned contracts, same as testnet: the WorkerRegistry genesis
    // predeploy is live on devnet and resolves them at runtime.
    expect(devnet.aiConfigAddress).toBeUndefined()
    expect(devnet.jobRegistryAddress).toBeUndefined()
  })

  it('leaves mainnet and testnet byte-identical', () => {
    expect(NETWORKS.mainnet.explorerUrl).toBe('https://mainnet.lightscan.app')
    expect(NETWORKS.mainnet.workerGatewayUrl).toBe('https://worker-gateway.mainnet.lightchain.ai')
    expect(NETWORKS.mainnet.image).toContain('lightchain-mainnet-public-docker')
    expect(NETWORKS.mainnet.relayUrl).toBe('wss://relay.mainnet.lightchain.ai/ws')
    expect(NETWORKS.testnet.explorerUrl).toBe('https://testnet.lightscan.app')
    expect(NETWORKS.testnet.workerGatewayUrl).toBe('https://worker-gateway.testnet.lightchain.ai')
    expect(NETWORKS.testnet.image).toContain('lightchain-testnet-public-docker')
    expect(NETWORKS.testnet.relayUrl).toBe('wss://relay.testnet.lightchain.ai/ws')
  })

  it('resolves a devnet config with its image and consolidated gateway', () => {
    const devnet = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'devnet' })
    expect(devnet.chainId).toBe(48221)
    expect(devnet.rpcUrl).toBe(NETWORKS.devnet.rpcUrl)
    expect(devnet.beaconApiUrl).toBe(NETWORKS.devnet.beaconApiUrl)
    expect(devnet.image).toBe(NETWORKS.testnet.image)
    expect(devnet.workerGatewayUrl).toBe(NETWORKS.devnet.consumerApiUrl)
    // Still not runnable until the addresses resolve — that is the ordinary
    // rule for any network whose profile pins none, not a devnet refusal.
    expect(isRunnable(devnet)).toBe(false)
  })

  it('builds the container commands on devnet, against the testnet image', () => {
    // Devnet used to refuse every docker verb for want of an image, which made
    // the network unusable for a worker even though its chain, registry and
    // stake are all live. The binary is configured entirely by environment, so
    // the testnet build serves here; what is still missing is the gateway, and
    // that costs dispatched work rather than the ability to run.
    const devnet = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'devnet' })
    for (const cmd of [pullImage(devnet), register(devnet, '/data/ks')]) {
      expect(cmd.argv.join(' ')).toContain('lightchain-testnet-public-docker')
    }
    // Nothing may hand the container the literal string "undefined" for a
    // hostname that does not exist.
    expect(register(devnet, '/data/ks').argv.join(' ')).toContain(
      'WORKER_GATEWAY_URL=https://chat-api.devnet-v2.lightchain.ai'
    )
    expect(register(devnet, '/data/ks').argv.join(' ')).not.toContain('undefined')
  })

  it('runs once the registry addresses resolve, which is all it was ever missing', async () => {
    // The WorkerRegistry predeploy answers on devnet, so the addresses come
    // back fine. With an image pinned there is no second wall behind them.
    const devnet = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'devnet' })
    const rpc = {
      async call(request: { to: string; data: string }) {
        const address =
          request.data === encodeCall('aiConfig()')
            ? '0x1111111111111111111111111111111111111111'
            : '0x2222222222222222222222222222222222222222'
        return `0x${'0'.repeat(24)}${address.slice(2)}`
      }
    }
    const resolved = await resolveContractAddresses(devnet, rpc)
    expect(isRunnable(resolved)).toBe(true)
    const cmd = runWorker(resolved, '/data/ks')
    expect(cmd.argv).toContain(NETWORKS.testnet.image)
    expect(cmd.argv.join(' ')).toContain('CHAIN_ID=48221')
  })
})

describe('per-field config inspection', () => {
  it('reports every bad field rather than collapsing at the first', () => {
    // One bad field used to throw and hide the rest, so a panel could only say
    // "not configured" when two things were wrong.
    const { config, problems } = inspectConfig({
      keysDir: '/k',
      keystorePassword: '',
      aiConfigAddress: '0x123',
      supportedModels: ['llama3 8b']
    })
    expect(config).toBeNull()
    expect(problems.map((p) => p.field)).toEqual([
      'keystorePassword',
      'aiConfigAddress',
      'supportedModels'
    ])
  })

  it('names the field and the remedy in each problem', () => {
    const { problems } = inspectConfig({ keysDir: '', keystorePassword: PASSWORD })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.field).toBe('keysDir')
    expect(problems[0]?.message).toContain('/data')
  })

  it('says which network the verdict was reached against', () => {
    expect(inspectConfig({ ...base, network: 'testnet' }).network).toBe('testnet')
    // An unknown network is the one case where even that cannot be derived.
    const unknown = inspectConfig({ ...base, network: 'marsnet' as never })
    expect(unknown.network).toBeNull()
    expect(unknown.problems[0]?.field).toBe('network')
    expect(unknown.problems[0]?.message).toContain('"marsnet"')
  })

  it('hands out a config only when nothing is wrong', () => {
    const clean = inspectConfig(base)
    expect(clean.problems).toEqual([])
    expect(clean.config?.chainId).toBe(9200)

    // A configuration with a bad field is never handed out half-resolved: the
    // docker builders accept whatever they are given, so the gate is here.
    const dirty = inspectConfig({ ...base, jobRegistryAddress: 'nope' })
    expect(dirty.config).toBeNull()
    expect(dirty.problems[0]?.message).toContain('jobRegistryAddress')
  })

  it('keeps resolveConfig fail-fast on the same messages', () => {
    expect(() => resolveConfig({ ...base, keystorePassword: '' })).toThrow(WorkerConfigError)
    expect(() => resolveConfig({ ...base, network: 'marsnet' as never })).toThrow(
      /unknown network "marsnet"/
    )
  })
})

describe('registry address resolution', () => {
  const AI_CONFIG = '0x1111111111111111111111111111111111111111'
  const JOB_REGISTRY = '0x2222222222222222222222222222222222222222'

  /** An ABI word carrying an address, and a record of what was asked. */
  function registryRpc() {
    const calls: { to: string; data: string }[] = []
    return {
      calls,
      async call(request: { to: string; data: string }) {
        calls.push(request)
        const address = request.data === encodeCall('aiConfig()') ? AI_CONFIG : JOB_REGISTRY
        return `0x${'0'.repeat(24)}${address.slice(2)}`
      }
    }
  }

  it('resolves testnet addresses from the WorkerRegistry at runtime', async () => {
    // The testnet profile pins none, and a baked-in copy would go stale — the
    // genesis predeploy knows the live pair.
    const partial = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'testnet' })
    expect(isRunnable(partial)).toBe(false)

    const rpc = registryRpc()
    const resolved = await resolveContractAddresses(partial, rpc)

    expect(resolved.aiConfigAddress).toBe(AI_CONFIG)
    expect(resolved.jobRegistryAddress).toBe(JOB_REGISTRY)
    expect(isRunnable(resolved)).toBe(true)
    // Both reads went to the genesis predeploy, not to anything configured.
    expect(rpc.calls.map((c) => c.to)).toEqual([WORKER_REGISTRY_ADDRESS, WORKER_REGISTRY_ADDRESS])

    // And the resolved config now builds the run command it previously refused.
    const joined = runWorker(resolved, '/data/ks').argv.join(' ')
    expect(joined).toContain(`AI_CONFIG_ADDRESS=${AI_CONFIG}`)
    expect(joined).toContain(`JOB_REGISTRY_ADDRESS=${JOB_REGISTRY}`)
  })

  it('never re-reads addresses that are already pinned', async () => {
    // Mainnet resolves from its profile alone; asking the registry anyway
    // would make a registry outage break a network that does not need it.
    const rpc = registryRpc()
    const same = await resolveContractAddresses(config, rpc)
    expect(same).toBe(config)
    expect(rpc.calls).toEqual([])
  })

  it('fills only the address that is missing', async () => {
    const override = '0x3333333333333333333333333333333333333333'
    const partial = resolveConfig({
      keysDir: '/k',
      keystorePassword: PASSWORD,
      network: 'testnet',
      aiConfigAddress: override
    })
    const resolved = await resolveContractAddresses(partial, registryRpc())
    expect(resolved.aiConfigAddress).toBe(override)
    expect(resolved.jobRegistryAddress).toBe(JOB_REGISTRY)
  })

  it('says which network could not be read when the registry call fails', async () => {
    const partial = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'testnet' })
    const failing = {
      async call() {
        throw new Error('connection refused')
      }
    }
    const err = await resolveContractAddresses(partial, failing).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerConfigError)
    const failure = err as WorkerConfigError
    expect(failure.message).toContain('testnet')
    expect(failure.message).toContain(WORKER_REGISTRY_ADDRESS)
    expect(failure.cause).toBeInstanceOf(Error)
  })
})

describe('the Windows Ollama address', () => {
  it('uses the IPv4 gateway on Windows', () => {
    // host.docker.internal resolves IPv6-first on Windows and Go's client
    // sticks to it, so Ollama requests hang rather than fail. The toolkit
    // documents this fix and does not apply it.
    expect(defaultOllamaUrl('win32')).toBe('http://192.168.65.254:11434')
  })

  it('uses the hostname elsewhere', () => {
    expect(defaultOllamaUrl('linux')).toBe('http://host.docker.internal:11434')
    expect(defaultOllamaUrl('darwin')).toBe('http://host.docker.internal:11434')
  })

  it('is applied through config resolution', () => {
    expect(resolveConfig({ ...base, platform: 'win32' }).ollamaUrl).toContain('192.168.65.254')
  })
})

describe('docker commands', () => {
  it('pulls the image for the selected network', () => {
    expect(pullImage(config).argv).toEqual(['pull', config.image])
  })

  it('runs detached with an always restart policy and the data volume', () => {
    const cmd = runWorker(config, '/data/eth-keystore/UTC--2026-01-01--abc')
    expect(cmd.argv.slice(0, 4)).toEqual(['run', '-d', '--restart', 'always'])
    expect(cmd.argv).toContain('--add-host=host.docker.internal:host-gateway')
    expect(cmd.argv).toContain(`${config.keysDir}:/data`)
    expect(cmd.argv.at(-1)).toBe(config.image)
  })

  it('passes every environment variable the worker needs', () => {
    const joined = runWorker(config, '/data/ks').argv.join(' ')
    for (const key of [
      'WORKER_KEYSTORE_PATH',
      'WORKER_KEYSTORE_PASSWORD',
      'ENCRYPTION_KEYSTORE_PATH',
      'RPC_URL',
      'CHAIN_ID',
      'WORKER_REGISTRY_ADDRESS',
      'AI_CONFIG_ADDRESS',
      'JOB_REGISTRY_ADDRESS',
      'SUPPORTED_MODELS',
      'OLLAMA_URL',
      'BEACON_API_URL',
      'BLOB_MODE=beacon',
      'SESSION_KEY_FILE',
      'WORKER_GATEWAY_URL'
    ]) {
      expect(joined, key).toContain(key)
    }
  })

  it('refuses to run before the registry addresses are known', () => {
    // Only reachable on a network the profile publishes no addresses for;
    // mainnet is runnable from its profile alone.
    const partial = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD, network: 'testnet' })
    expect(() => runWorker(partial, '/data/ks')).toThrow(/resolveContractAddresses/)
  })

  it('registers against the published mainnet contracts with nothing configured', () => {
    // The live failure this guards: the image refuses to load its config when
    // AI_CONFIG_ADDRESS is absent, so registration could never work for a user
    // who never exported the variable.
    const bare = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD })
    const joined = register(bare, '/data/ks').argv.join(' ')
    expect(joined).toContain('AI_CONFIG_ADDRESS=0x24D11533C354092ed6E18b964257819cE78Ce77D')
    expect(joined).toContain('JOB_REGISTRY_ADDRESS=0xfB15F90298e4CcD7106E76ffB5e520315cC42B0b')
  })

  it('removes the container forcibly on stop, since it restarts always', () => {
    expect(stopWorker(config).argv).toEqual(['rm', '-f', 'lightchain-worker'])
  })
})

describe('secret handling', () => {
  it('never shows the keystore password in the printable form', () => {
    for (const cmd of [
      runWorker(config, '/data/ks'),
      register(config, '/data/ks'),
      generateEncryptionKey(config)
    ]) {
      expect(cmd.display).not.toContain(PASSWORD)
      expect(cmd.display).toContain('<redacted>')
    }
  })

  it('hands the private key to no docker command at all', () => {
    // There used to be an `importKey` that passed `--private-key <hex>`, and a
    // test here asserting the key was in argv while absent from `display`. That
    // was the bug written down as a feature: redacting what we print does
    // nothing about `ps`, `/proc` or `docker inspect`. The supervisor writes the
    // keystore itself now, so no command can carry a key.
    const everything = [
      pullImage(config),
      runWorker(config, '/data/ks'),
      register(config, '/data/ks'),
      generateEncryptionKey(config),
      stopWorker(config),
      inspectWorker(config),
      logsWorker(config)
    ]

    for (const cmd of everything) {
      expect(cmd.argv.join(' ')).not.toContain(PRIVKEY)
      expect(cmd.display).not.toContain(PRIVKEY)
    }
  })

  it('still passes the real secrets in argv, since only display is redacted', () => {
    expect(runWorker(config, '/data/ks').argv.join(' ')).toContain(PASSWORD)
  })
})

describe('keystore selection', () => {
  const A = 'UTC--2026-01-01T10-00-00.000Z--1111111111111111111111111111111111111111'
  const B = 'UTC--2026-02-02T11-00-00.000Z--2222222222222222222222222222222222222222'

  it('picks the only keystore and reads its address', () => {
    expect(selectKeystore([A])).toEqual({ file: A, address: '1'.repeat(40) })
  })

  it('ignores files that are not keystores', () => {
    expect(selectKeystore(['.gitkeep', 'notes.txt', A, 'session-keys.enc']).file).toBe(A)
  })

  it('refuses to guess between two keystores', () => {
    // Choosing arbitrarily would run the worker under an address the operator
    // did not intend, and it would register and earn to the wrong account
    // without anything looking wrong.
    expect(() => selectKeystore([A, B])).toThrow(/ambiguous/)
  })

  it('selects by address when one is given', () => {
    expect(selectKeystore([A, B], `0x${'2'.repeat(40)}`).file).toBe(B)
    expect(selectKeystore([A, B], '2'.repeat(40)).file).toBe(B)
  })

  it('lists what it found when the address does not match', () => {
    const err = () => selectKeystore([A], `0x${'9'.repeat(40)}`)
    expect(err).toThrow(/no keystore for address/)
    expect(err).toThrow(new RegExp('1'.repeat(40)))
  })

  it('says what to do when there is no keystore', () => {
    expect(() => selectKeystore([])).toThrow(/Import a key first/)
    expect(() => selectKeystore(['random.txt'])).toThrow(/Import a key first/)
  })

  it('maps to the container path', () => {
    expect(containerKeystorePath(A)).toBe(`/data/eth-keystore/${A}`)
  })

  it('names a keystore the way go-ethereum reads them back', () => {
    // The worker finds its key by listing this directory with go-ethereum, and
    // `selectKeystore` reads the address out of the name, so a file we write
    // has to be one both of them recognise.
    const name = keystoreFileName('0xAbCdEf0123456789AbCdEf0123456789AbCdEf01', new Date(0))

    expect(name).toBe('UTC--1970-01-01T00-00-00.000Z--abcdef0123456789abcdef0123456789abcdef01')
    expect(selectKeystore([name])).toEqual({
      file: name,
      address: 'abcdef0123456789abcdef0123456789abcdef01'
    })
  })

  it('leaves no colons in the name, since Windows will not have them', () => {
    expect(keystoreFileName('0x' + '1'.repeat(40))).not.toContain(':')
  })

  it('refuses something that is not an address', () => {
    expect(() => keystoreFileName('nope')).toThrow(KeystoreError)
    expect(() => keystoreFileName('0x' + '1'.repeat(39))).toThrow(KeystoreError)
  })
})

describe('container state', () => {
  const inspect = (state: object, restartCount = 0) =>
    JSON.stringify([{ State: state, RestartCount: restartCount }])

  it('reports an absent container', () => {
    expect(parseContainerState(null).health).toBe('absent')
    expect(parseContainerState('').health).toBe('absent')
  })

  it('reports a healthy container', () => {
    const s = parseContainerState(inspect({ Running: true, StartedAt: '2026-08-17T10:00:00Z' }))
    expect(s.health).toBe('running')
    expect(isHealthy(s)).toBe(true)
  })

  it('calls out a restart loop even though the container is running', () => {
    // The dangerous case. docker ps says up, and it is crashing every few
    // seconds and taking no jobs.
    const s = parseContainerState(inspect({ Running: true }, 7))
    expect(s.health).toBe('restart-loop')
    expect(isHealthy(s)).toBe(false)
    expect(s.remedy).toMatch(/keystore password|chain ID|RPC/)
  })

  it('tolerates a couple of restarts without crying wolf', () => {
    expect(parseContainerState(inspect({ Running: true }, 1)).health).toBe('running')
  })

  it('distinguishes a clean stop from a crash', () => {
    expect(parseContainerState(inspect({ Running: false, ExitCode: 0 })).health).toBe('stopped')
    const crashed = parseContainerState(inspect({ Running: false, ExitCode: 1, Error: 'boom' }))
    expect(crashed.health).toBe('exited-error')
    expect(crashed.detail).toContain('boom')
  })

  it('survives malformed output instead of throwing', () => {
    expect(parseContainerState('not json').health).toBe('absent')
    expect(parseContainerState('{}').health).toBe('absent')
  })
})

describe('choosing from what the network offers', () => {
  // The live mainnet whitelist at the time of writing. Four of the seven
  // carry a colon, which is the whole point.
  const OFFERED = [
    'llama3-8b',
    'llama3-70b',
    'gemma4:e2b',
    'gpt-oss:20b',
    'qwen3-vl:8b',
    'qwen3-coder-next',
    'gpt-oss:120b'
  ]

  it('accepts every name the network publishes', () => {
    expect(unwhitelistedModels(OFFERED, OFFERED)).toEqual([])
  })

  it('catches a registry reference typed where the network name belongs', () => {
    // The mistake the old colon rule was reaching for, caught correctly —
    // llama3:8b is Ollama's spelling, llama3-8b is the network's.
    expect(unwhitelistedModels(['llama3:8b'], OFFERED)).toEqual(['llama3:8b'])
  })

  it('points at the name that was meant', () => {
    expect(nearestOfferedModel('llama3:8b', OFFERED)).toBe('llama3-8b')
    expect(nearestOfferedModel('gpt-oss-20b', OFFERED)).toBe('gpt-oss:20b')
  })

  it('suggests nothing when the guess would be ambiguous or absent', () => {
    expect(nearestOfferedModel('mistral', OFFERED)).toBeNull()
  })

  it('matches exactly, because the worker hashes the exact string', () => {
    expect(unwhitelistedModels(['GPT-OSS:20B'], OFFERED)).toEqual(['GPT-OSS:20B'])
  })
})
