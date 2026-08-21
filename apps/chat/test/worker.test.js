import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The worker panel's honesty tests.
 *
 * Three audit findings meet here: the keystore password sat in settings.json
 * in the clear; a wrong password was discovered by `docker run` failing; and a
 * failed stake probe rendered identically to a machine that never had a key —
 * which is how "restored my seed, worker setup reset" happened when the real
 * state was an ambiguous keystore directory.
 *
 * The handlers under test read the filesystem through bare-fs and the chain
 * through an RPC client; both are replaced below, the first with an in-memory
 * filesystem, the second with an answer-per-call mock that speaks real ABI
 * words, so the encoding path is exercised rather than assumed.
 */

const mockFs = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn()
}))

const mockHost = vi.hoisted(() => ({
  probeAll: vi.fn(async () => ({})),
  runAsync: vi.fn(async () => ({ ok: false, status: 1, stdout: '', stderr: 'docker: not found' }))
}))

vi.mock('bare-path', async () => ({ default: (await import('node:path')).posix }))
vi.mock('bare-fs', () => ({ default: mockFs }))
vi.mock('@lcai-p2p/host', () => ({ probeAll: mockHost.probeAll, runAsync: mockHost.runAsync }))

import { encodeCall } from '@lcai-p2p/chain'
import { SealedStore, encrypt, memoryByteStore } from '@lcai-p2p/wallet'
import { KEYSTORE_DIR, keystoreFileName } from '@lcai-p2p/worker'
import {
  WORKER_PASSWORD_DOC,
  checkKeystorePassword,
  migrateWorkerPassword,
  readWorkerPassword,
  workerHandlers
} from '../workers/handlers/worker.mjs'

const ADDRESS = 'ab'.repeat(20)
const KEYSTORE_NAME = keystoreFileName(ADDRESS, new Date('2026-01-01T00:00:00Z'))

const word = (hex) => `0x${'0'.repeat(64 - hex.length)}${hex}`
const BOOL = { true: word('1'), false: word('0') }
const uint = (n) => word(n.toString(16))
const addressWord = (addr) => word(addr.replace(/^0x/, ''))

const CONFIG = {
  network: 'mainnet',
  chainId: 9200,
  keysDir: '/keys',
  keystorePassword: 'unset',
  containerName: 'lightchain-worker',
  supportedModels: ['llama3-8b'],
  ollamaUrl: 'http://localhost:11434',
  aiConfigAddress: `0x${'11'.repeat(20)}`,
  jobRegistryAddress: `0x${'22'.repeat(20)}`
}

/** An RPC mock that answers by call signature, in real ABI words. */
function rpcWith({ registered = false, minimum = 50_000n * 10n ** 18n, balance = 60_000n * 10n ** 18n } = {}) {
  const selRegistered = encodeCall('isWorkerRegistered(address)', ['address'], [`0x${ADDRESS}`]).slice(0, 10)
  const selAiConfig = encodeCall('aiConfig()').slice(0, 10)
  const selJobRegistry = encodeCall('jobRegistry()').slice(0, 10)
  const selMinimum = encodeCall('getMinWorkerStake()').slice(0, 10)

  return {
    call: vi.fn(async ({ data }) => {
      const selector = data.slice(0, 10)
      if (selector === selRegistered) return registered ? BOOL.true : BOOL.false
      if (selector === selAiConfig) return addressWord(CONFIG.aiConfigAddress)
      if (selector === selJobRegistry) return addressWord(CONFIG.jobRegistryAddress)
      if (selector === selMinimum) return uint(minimum)
      throw new Error(`unexpected call: ${data}`)
    }),
    balanceOf: vi.fn(async () => balance)
  }
}

function ctxWith({ config = CONFIG, problem = null, rpc = rpcWith(), password } = {}) {
  return {
    rpc: () => rpc,
    send: vi.fn(),
    // The real workerConfig applies overrides over the resolved config; the
    // key ceremonies rely on that to encrypt under the request's password.
    workerConfig: (overrides = {}) => ({
      config: config === null ? null : { ...config, ...overrides },
      problem
    }),
    workerKeystorePassword: () => password,
    adoptWorkerPassword: vi.fn()
  }
}

/** An in-memory stand-in for the keystore directory. */
function memFs(entries = {}) {
  const files = new Map(Object.entries(entries))

  mockFs.readdirSync.mockImplementation((dir) => {
    const names = []
    for (const file of files.keys()) {
      const slash = file.lastIndexOf('/')
      if (file.slice(0, slash) === dir) names.push(file.slice(slash + 1))
    }
    return names
  })
  mockFs.readFileSync.mockImplementation((file) => {
    if (!files.has(file)) throw new Error(`ENOENT: ${file}`)
    return files.get(file)
  })
  mockFs.writeFileSync.mockImplementation((file, data) => {
    files.set(file, String(data))
  })
  mockFs.mkdirSync.mockImplementation(() => {})

  return files
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHost.probeAll.mockResolvedValue({})
  mockHost.runAsync.mockResolvedValue({ ok: false, status: 1, stdout: '', stderr: 'docker: not found' })
})

describe('worker.stake', () => {
  it('reports a registered worker plainly, naming the network probed', async () => {
    memFs({ [`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`]: '{}' })
    const handlers = workerHandlers(ctxWith({ rpc: rpcWith({ registered: true }) }))

    const stake = await handlers['worker.stake']()

    expect(stake).toMatchObject({
      configured: true,
      network: 'mainnet',
      address: `0x${ADDRESS}`,
      registered: true,
      unreachable: false,
      problem: null
    })
  })

  it('returns the minimum and balance as decimal strings for an unregistered key', async () => {
    memFs({ [`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`]: '{}' })
    const handlers = workerHandlers(ctxWith())

    const stake = await handlers['worker.stake']()

    expect(stake).toMatchObject({
      configured: true,
      network: 'mainnet',
      address: `0x${ADDRESS}`,
      registered: false,
      problem: null,
      minimum: (50_000n * 10n ** 18n).toString(),
      balance: (60_000n * 10n ** 18n).toString()
    })
  })

  it('says which error left the chain unreachable instead of only flagging it', async () => {
    memFs({ [`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`]: '{}' })
    const rpc = { call: vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))) }
    const handlers = workerHandlers(ctxWith({ rpc }))

    const stake = await handlers['worker.stake']()

    expect(stake.address).toBe(`0x${ADDRESS}`)
    expect(stake.unreachable).toBe(true)
    expect(stake.problem).toContain('ECONNREFUSED')
  })

  it('reports an ambiguous keystore directory as a problem, not as "No key"', async () => {
    // The user report: a restored seed left two keystores, and the panel drew
    // a wiped install because the probe swallowed the error.
    const other = keystoreFileName('0011223344556677889900aabbccddee00112233', new Date('2026-02-01T00:00:00Z'))
    memFs({
      [`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`]: '{}',
      [`/keys/${KEYSTORE_DIR}/${other}`]: '{}'
    })
    const handlers = workerHandlers(ctxWith())

    const stake = await handlers['worker.stake']()

    expect(stake.address).toBeNull()
    expect(stake.problem).toMatch(/ambiguous/)
    expect(stake.unreachable).toBe(false)
  })

  it('keeps a genuinely empty keystore directory quiet: no address, no problem', async () => {
    memFs()
    const handlers = workerHandlers(ctxWith())

    const stake = await handlers['worker.stake']()

    expect(stake.address).toBeNull()
    expect(stake.problem).toBeNull()
    expect(stake.minimum).toBeNull()
    expect(stake.balance).toBeNull()
  })

  it('reads a missing keystore directory as the same quiet first-run state', async () => {
    // First run: nothing has ever created the directory, so readdirSync throws
    // ENOENT before selectKeystore's handled case is reached. That is the
    // empty state, not a fault — and certainly not a raw ENOENT with a
    // platform path on the Earn panel.
    memFs()
    mockFs.readdirSync.mockImplementation(() => {
      throw Object.assign(
        new Error("ENOENT: no such file or directory, scandir '/keys/eth-keystore'"),
        { code: 'ENOENT' }
      )
    })
    const handlers = workerHandlers(ctxWith())

    const stake = await handlers['worker.stake']()

    expect(stake.address).toBeNull()
    expect(stake.problem).toBeNull()
    expect(stake.minimum).toBeNull()
    expect(stake.balance).toBeNull()
  })

  it('still names a keystore directory that is unreadable for any other reason', async () => {
    // Missing is ordinary; refused is not. A permission failure has a fix the
    // operator can make, and it must not render as a wiped install.
    memFs()
    mockFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    const handlers = workerHandlers(ctxWith())

    const stake = await handlers['worker.stake']()

    expect(stake.address).toBeNull()
    expect(stake.problem).toMatch(/EPERM/)
  })

  it('reports the configuration problem when there is no worker config', async () => {
    const handlers = workerHandlers(ctxWith({ config: null, problem: 'keysDir is required' }))

    const stake = await handlers['worker.stake']()

    expect(stake).toEqual({ configured: false, problem: 'keysDir is required', network: null })
  })
})

describe('worker.status', () => {
  it('carries the probe problem and address alongside the container state', async () => {
    const other = keystoreFileName('0011223344556677889900aabbccddee00112233', new Date('2026-02-01T00:00:00Z'))
    memFs({
      [`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`]: '{}',
      [`/keys/${KEYSTORE_DIR}/${other}`]: '{}'
    })
    const handlers = workerHandlers(ctxWith())

    const status = await handlers['worker.status']()

    expect(status.configured).toBe(true)
    expect(status.network).toBe('mainnet')
    expect(status.address).toBeNull()
    expect(status.problem).toMatch(/ambiguous/)
    // The container inspection still ran; a dead Docker is state, not an error.
    expect(status.healthy).toBe(false)
  })

  it('is configured:false with a null network when there is no config', async () => {
    const handlers = workerHandlers(ctxWith({ config: null, problem: 'keysDir is required' }))

    const status = await handlers['worker.status']()

    expect(status).toEqual({ configured: false, problem: 'keysDir is required', network: null })
  })
})

describe('the sealed keystore password', () => {
  const account = {
    address: `0x${'33'.repeat(20)}`,
    signMessage: () => `0x${'ab'.repeat(65)}`
  }

  function secretsWith(unlocked = true) {
    return new SealedStore(memoryByteStore(), {
      purpose: 'worker secrets',
      account: () => (unlocked ? account : null)
    })
  }

  it('migrates a plaintext settings password into the sealed store and deletes the plaintext', () => {
    const secrets = secretsWith()
    const saved = []
    const migrated = migrateWorkerPassword({
      secrets,
      settings: { network: 'mainnet', workerPassword: 'plaintext-pw' },
      saveSettings: (next) => saved.push(next),
      log: () => {}
    })

    expect(migrated).toBe(true)
    expect(saved).toEqual([{ network: 'mainnet' }])
    // Sealed for real: the same store reads the password back under the key.
    expect(secrets.read(WORKER_PASSWORD_DOC, null)).toBe('plaintext-pw')
  })

  it('leaves the plaintext in place while the wallet is locked, to migrate on a later unlock', () => {
    const secrets = secretsWith(false)
    const saved = []

    const migrated = migrateWorkerPassword({
      secrets,
      settings: { workerPassword: 'plaintext-pw' },
      saveSettings: (next) => saved.push(next),
      log: () => {}
    })

    // Sealing without a key would mean dropping the password entirely, which
    // strands a configured worker. Keeping the plaintext one more lock cycle
    // is the smaller evil.
    expect(migrated).toBe(false)
    expect(saved).toEqual([])
  })

  it('does nothing when there is no plaintext to migrate', () => {
    const secrets = secretsWith()
    const saved = []

    const migrated = migrateWorkerPassword({
      secrets,
      settings: { network: 'mainnet' },
      saveSettings: (next) => saved.push(next),
      log: () => {}
    })

    expect(migrated).toBe(false)
    expect(saved).toEqual([])
    expect(secrets.read(WORKER_PASSWORD_DOC, null)).toBeNull()
  })

  it('reads the sealed password first and the environment as the fallback', () => {
    const secrets = secretsWith()
    expect(readWorkerPassword(secrets, {})).toBeUndefined()
    expect(readWorkerPassword(secrets, { WORKER_PASSWORD: 'from-env' })).toBe('from-env')

    secrets.write(WORKER_PASSWORD_DOC, 'sealed-pw')
    expect(readWorkerPassword(secrets, { WORKER_PASSWORD: 'from-env' })).toBe('sealed-pw')
  })

  it('reads as unset while the wallet is locked, whatever was sealed', () => {
    const unlocked = secretsWith()
    unlocked.write(WORKER_PASSWORD_DOC, 'sealed-pw')

    const locked = secretsWith(false)
    expect(locked.read(WORKER_PASSWORD_DOC, null)).toBeNull()
    expect(readWorkerPassword(locked, {})).toBeUndefined()
  })
})

describe('checking the password against the keystore', () => {
  it('passes when the password opens the keystore', () => {
    const keystore = encrypt(`0x${'44'.repeat(32)}`, 'right-password')
    const file = keystoreFileName(keystore.address, new Date('2026-01-01T00:00:00Z'))
    memFs({ [`/keys/${KEYSTORE_DIR}/${file}`]: JSON.stringify(keystore) })

    expect(checkKeystorePassword(CONFIG, 'right-password')).toEqual({ ok: true, problem: null })
  })

  it('fails at setup, not inside the container, when the password is wrong', () => {
    const keystore = encrypt(`0x${'44'.repeat(32)}`, 'right-password')
    const file = keystoreFileName(keystore.address, new Date('2026-01-01T00:00:00Z'))
    memFs({ [`/keys/${KEYSTORE_DIR}/${file}`]: JSON.stringify(keystore) })

    const check = checkKeystorePassword(CONFIG, 'wrong-password')
    expect(check.ok).toBe(false)
    expect(check.problem).toMatch(/does not open the worker keystore/)
  })
})

describe('worker.importKey', () => {
  const privateKey = `0x${'55'.repeat(32)}`

  it('writes the keystore, proves the password opens it, and only then adopts it', () => {
    const files = memFs()
    const ctx = ctxWith()
    const handlers = workerHandlers(ctx)

    const result = handlers['worker.importKey']({ privateKey, password: 'adopt-me-now' })

    expect(result.address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(ctx.adoptWorkerPassword).toHaveBeenCalledWith('adopt-me-now')

    // The file on "disk" is a real keystore the adopted password opens.
    const written = [...files.entries()].find(([name]) => name.startsWith('UTC--') || name.includes('UTC--'))
    expect(written).toBeTruthy()
    expect(checkKeystorePassword(CONFIG, 'adopt-me-now').ok).toBe(true)
  })

  it('refuses to adopt a password that does not open the keystore', () => {
    memFs()
    // The write lands, but reading the file back hands over garbage — a
    // failing disk, a racing edit. The password must not be adopted anyway.
    mockFs.readFileSync.mockImplementation(() => '{"version":3,"crypto":{}}')
    const ctx = ctxWith()
    const handlers = workerHandlers(ctx)

    expect(() => handlers['worker.importKey']({ privateKey, password: 'adopt-me-now' })).toThrow(
      /not adopting the password/
    )
    expect(ctx.adoptWorkerPassword).not.toHaveBeenCalled()
  })

  it('rejects a short password before anything is written', () => {
    memFs()
    const ctx = ctxWith()
    const handlers = workerHandlers(ctx)

    expect(() => handlers['worker.importKey']({ privateKey, password: 'short' })).toThrow(
      /at least 8 characters/
    )
    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    expect(ctx.adoptWorkerPassword).not.toHaveBeenCalled()
  })
})

describe('worker.doctor', () => {
  it('checks the password against the keystore and says so', async () => {
    const keystore = encrypt(`0x${'66'.repeat(32)}`, 'doctor-password')
    const file = keystoreFileName(keystore.address, new Date('2026-01-01T00:00:00Z'))
    memFs({ [`/keys/${KEYSTORE_DIR}/${file}`]: JSON.stringify(keystore) })
    const handlers = workerHandlers(ctxWith({ password: 'doctor-password' }))

    const doctor = await handlers['worker.doctor']()

    expect(doctor.network).toBe('mainnet')
    expect(doctor.password).toEqual({ checked: true, ok: true, problem: null })
  })

  it('fails the password check with the reason when the password is wrong', async () => {
    const keystore = encrypt(`0x${'66'.repeat(32)}`, 'doctor-password')
    const file = keystoreFileName(keystore.address, new Date('2026-01-01T00:00:00Z'))
    memFs({ [`/keys/${KEYSTORE_DIR}/${file}`]: JSON.stringify(keystore) })
    const handlers = workerHandlers(ctxWith({ password: 'not-it' }))

    const doctor = await handlers['worker.doctor']()

    expect(doctor.password.checked).toBe(true)
    expect(doctor.password.ok).toBe(false)
    expect(doctor.password.problem).toMatch(/does not open/)
  })

  it('says the check was skipped when the wallet is locked', async () => {
    memFs({ [`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`]: '{}' })
    const handlers = workerHandlers(ctxWith({ password: undefined }))

    const doctor = await handlers['worker.doctor']()

    expect(doctor.password).toEqual({
      checked: false,
      ok: null,
      problem: 'no keystore password is available; unlock the wallet'
    })
  })
})
