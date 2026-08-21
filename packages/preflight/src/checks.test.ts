import { describe, expect, it } from 'vitest'
import { GIB, DEFAULT_REQUIREMENTS } from './requirements.js'
import { isReady, runChecks, summarize, type Probes } from './checks.js'

/** A host that satisfies everything, so each test can spoil exactly one thing. */
const healthy: Probes = {
  docker: { cliPresent: true, daemonRunning: true, version: '27.0.3' },
  ollama: { reachable: true, models: ['llama3-8b:latest', 'llama3:8b'] },
  gpu: { detected: true, name: 'RTX 4070', vramBytes: 12 * GIB },
  memory: { totalBytes: 32 * GIB },
  disk: { freeBytes: 200 * GIB },
  cast: { present: true, version: '1.7.1' }
}

/**
 * The models a worker has chosen, which is a caller's answer and never a
 * default. `DEFAULT_REQUIREMENTS` names none, so every test that is about a
 * model has to say which one — the same thing the application does when it
 * passes the worker's configured list.
 */
const serving = (...models: string[]) => ({ ...DEFAULT_REQUIREMENTS, requiredModels: models })
const CHOSEN = serving('llama3-8b')

const find = (probes: Probes, id: string, requirements = CHOSEN) =>
  runChecks(probes, requirements).find((r) => r.id === id)

describe('a healthy host', () => {
  it('is ready', () => {
    const results = runChecks(healthy, CHOSEN)
    expect(isReady(results)).toBe(true)
    expect(summarize(results).failed).toBe(0)
  })

  it('explains the benign startup warning rather than leaving it to be reported as a fault', () => {
    // The model is present as llama3-8b:latest, not llama3-8b, so the worker
    // logs a verification warning. It works, but operators reliably raise it.
    const model = find(healthy, 'model:llama3-8b')
    expect(model?.status).toBe('pass')
    expect(model?.detail).toMatch(/benign/)
  })
})

describe('docker', () => {
  it('separates a missing CLI from a stopped daemon', () => {
    const noCli = find(
      { ...healthy, docker: { cliPresent: false, daemonRunning: false } },
      'docker'
    )
    expect(noCli?.status).toBe('fail')
    expect(noCli?.remedy).toMatch(/Install Docker/)

    // The CLI existing tells you nothing, and this is the single most common
    // way the toolkit fails several phases later.
    const stopped = find(
      { ...healthy, docker: { cliPresent: true, daemonRunning: false } },
      'docker'
    )
    expect(stopped?.status).toBe('fail')
    expect(stopped?.remedy).toMatch(/Start Docker Desktop/)

    // The same split as Ollama's, for the same reason.
    expect(noCli?.action).toBe('install-docker')
    expect(stopped?.action).toBe('start-docker')
  })
})

describe('ollama', () => {
  it('fails when nothing is listening', () => {
    const r = find({ ...healthy, ollama: { reachable: false } }, 'ollama')
    expect(r?.status).toBe('fail')
  })

  it('tells an absent runtime from a stopped one, because the fix differs', () => {
    // The same unreachable port, and two different jobs. Offering "start it" to
    // somebody who has never installed it is a button that cannot work, and
    // offering "install it" to somebody who has is a download they do not need.
    const absent = find({ ...healthy, ollama: { reachable: false, cliPresent: false } }, 'ollama')
    expect(absent?.action).toBe('install-ollama')
    expect(absent?.detail).toMatch(/not installed/)

    const stopped = find({ ...healthy, ollama: { reachable: false, cliPresent: true } }, 'ollama')
    expect(stopped?.action).toBe('start-ollama')
    expect(stopped?.detail).toMatch(/installed but nothing answered/)
  })

  it('offers to start when the probe could not say either way', () => {
    // An unprobed CLI is the old behaviour and stays the safer of the two: the
    // command exists far more often than not on a host that got this far.
    expect(find({ ...healthy, ollama: { reachable: false } }, 'ollama')?.action).toBe(
      'start-ollama'
    )
  })

  it('accepts an exact name match', () => {
    const r = find(
      { ...healthy, ollama: { reachable: true, models: ['llama3-8b'] } },
      'model:llama3-8b'
    )
    expect(r?.status).toBe('pass')
    expect(r?.detail).toBe('present')
  })

  it('fails when only the upstream name exists, because the alias is what jobs resolve against', () => {
    // llama3:8b is pulled but never aliased to llama3-8b. The worker then cannot
    // resolve queued jobs and reports an opaque model hash mismatch.
    const r = find(
      { ...healthy, ollama: { reachable: true, models: ['llama3:8b'] } },
      'model:llama3-8b'
    )
    expect(r?.status).toBe('fail')
    expect(r?.remedy).toMatch(/SUPPORTED_MODELS/)
    // Naming the copy is the half that gets missed, so the remedy names it too.
    expect(r?.remedy).toMatch(/names a copy llama3-8b/)
    expect(r?.action).toBe('fetch-model')
  })

  it('says so plainly when there are no models at all', () => {
    const r = find({ ...healthy, ollama: { reachable: true, models: [] } }, 'model:llama3-8b')
    expect(r?.detail).toMatch(/no models at all/)
  })

  it('checks every configured model', () => {
    const results = runChecks(
      { ...healthy, ollama: { reachable: true, models: ['llama3-8b'] } },
      serving('llama3-8b', 'mistral-7b')
    )
    expect(results.find((r) => r.id === 'model:llama3-8b')?.status).toBe('pass')
    expect(results.find((r) => r.id === 'mistral-7b' || r.id === 'model:mistral-7b')?.status).toBe(
      'fail'
    )
  })
})

describe('gpu', () => {
  it('fails below the VRAM floor', () => {
    const r = find(
      { ...healthy, gpu: { detected: true, name: 'GTX 1060', vramBytes: 6 * GIB } },
      'gpu'
    )
    expect(r?.status).toBe('fail')
    expect(r?.detail).toMatch(/6\.0 GB/)
    expect(r?.remedy).toMatch(/8\.0 GB/)
  })

  it('accepts exactly the floor', () => {
    expect(find({ ...healthy, gpu: { detected: true, vramBytes: 8 * GIB } }, 'gpu')?.status).toBe(
      'pass'
    )
  })

  it('passes Apple unified memory, which reports no discrete VRAM', () => {
    const r = find(
      { ...healthy, gpu: { detected: true, name: 'Apple M3', unifiedMemory: true } },
      'gpu'
    )
    expect(r?.status).toBe('pass')
  })

  it('warns rather than fails when VRAM cannot be read', () => {
    // Refusing to start over an unreadable number would be worse than saying so.
    const r = find({ ...healthy, gpu: { detected: true, name: 'Some GPU' } }, 'gpu')
    expect(r?.status).toBe('warn')
  })

  it('fails when there is no GPU', () => {
    expect(find({ ...healthy, gpu: { detected: false } }, 'gpu')?.status).toBe('fail')
  })
})

describe('disk and memory', () => {
  it('fails on insufficient disk', () => {
    expect(find({ ...healthy, disk: { freeBytes: 20 * GIB } }, 'disk')?.status).toBe('fail')
  })

  it('only warns on low memory, which degrades rather than prevents', () => {
    expect(find({ ...healthy, memory: { totalBytes: 8 * GIB } }, 'memory')?.status).toBe('warn')
  })
})

describe('cast', () => {
  it('blames the shell, not the install', () => {
    const r = find({ ...healthy, cast: { present: false } }, 'cast')
    expect(r?.status).toBe('fail')
    expect(r?.remedy).toMatch(/new terminal/)
  })
})

describe('reporting', () => {
  it('warnings do not block readiness', () => {
    const results = runChecks({ ...healthy, memory: { totalBytes: 8 * GIB } }, CHOSEN)
    expect(summarize(results)).toMatchObject({ ready: true, warned: 1 })
  })

  it('refuses to call a worker ready when it has chosen no models', () => {
    // The empty list is the out-of-the-box state, and it has to be a failure
    // rather than a quiet pass: such a worker starts, connects and is offered
    // nothing, which is indistinguishable from a network with no demand.
    const results = runChecks(healthy, DEFAULT_REQUIREMENTS)
    expect(isReady(results)).toBe(false)

    const models = results.find((r) => r.id === 'models')
    expect(models?.status).toBe('fail')
    expect(models?.action).toBe('choose-models')

    // And no row invents a model name to complain about.
    expect(results.some((r) => r.id.startsWith('model:'))).toBe(false)
  })

  it('an unprobed host warns rather than falsely passing', () => {
    const results = runChecks({})

    // Counted before the `every`, which is otherwise satisfied by an empty
    // array — and `isReady([])` is true as well, so a version of `runChecks`
    // that returned nothing would pass both assertions below while checking
    // nothing at all.
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.status === 'warn')).toBe(true)
    expect(isReady(results)).toBe(true)
  })

  it('every non-pass carries a remedy', () => {
    // The point of the package. A verdict with no action is just a louder error.
    const broken = runChecks({
      docker: { cliPresent: true, daemonRunning: false },
      ollama: { reachable: true, models: [] },
      gpu: { detected: false },
      memory: { totalBytes: 4 * GIB },
      disk: { freeBytes: 1 * GIB },
      cast: { present: false }
    })
    for (const r of broken.filter((x) => x.status !== 'pass')) {
      expect(r.remedy, `${r.id} has no remedy`).toBeTruthy()
    }
  })
})
