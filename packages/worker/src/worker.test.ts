import { describe, expect, it } from 'vitest'
import {
  NETWORKS,
  WorkerConfigError,
  defaultOllamaUrl,
  generateEncryptionKey,
  importKey,
  isHealthy,
  isRunnable,
  parseContainerState,
  pullImage,
  register,
  resolveConfig,
  runWorker,
  stopWorker
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

  it('rejects a tagged model name', () => {
    // The worker matches jobs on keccak256 of this exact string, so a tag
    // suffix stops every job resolving and reports as a model hash mismatch.
    expect(() => resolveConfig({ ...base, supportedModels: ['llama3-8b:latest'] })).toThrow(
      /keccak256/
    )
  })

  it('rejects a malformed contract address', () => {
    expect(() => resolveConfig({ ...base, aiConfigAddress: '0x123' })).toThrow(WorkerConfigError)
  })

  it('is not runnable until the registry addresses are resolved', () => {
    const partial = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD })
    expect(isRunnable(partial)).toBe(false)
    expect(isRunnable(config)).toBe(true)
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
    const partial = resolveConfig({ keysDir: '/k', keystorePassword: PASSWORD })
    expect(() => runWorker(partial, '/data/ks')).toThrow(/aiConfig\(\)/)
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
      generateEncryptionKey(config),
      importKey(config, PRIVKEY)
    ]) {
      expect(cmd.display).not.toContain(PASSWORD)
      expect(cmd.display).toContain('<redacted>')
    }
  })

  it('never shows the private key', () => {
    const cmd = importKey(config, PRIVKEY)
    // This is the one that ends up pasted into a support channel.
    expect(cmd.display).not.toContain(PRIVKEY)
    expect(cmd.argv).toContain(PRIVKEY)
  })

  it('still passes the real secrets in argv, since only display is redacted', () => {
    expect(runWorker(config, '/data/ks').argv.join(' ')).toContain(PASSWORD)
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
