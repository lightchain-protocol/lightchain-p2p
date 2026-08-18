import { DEFAULT_REQUIREMENTS, formatBytes, type Requirements } from './requirements.js'

/**
 * Preflight checks for a worker host.
 *
 * Deliberately pure: probing the host is I/O and belongs in the application,
 * while deciding whether a host is fit to run a worker is judgement and belongs
 * where it can be tested exhaustively without Docker, a GPU or a network.
 *
 * The remedies matter as much as the verdicts. The existing toolkit documents
 * sixteen failure modes and detects none of them, so operators meet them as
 * opaque errors several phases after the cause. Every failure here names what to
 * do about it.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  /** What was observed. */
  readonly detail: string
  /** What to do about it. Present whenever the status is not a pass. */
  readonly remedy?: string
}

/** Raw observations of the host. Every field is optional: a probe may not have run. */
export interface Probes {
  readonly docker?: DockerProbe
  readonly ollama?: OllamaProbe
  readonly gpu?: GpuProbe
  readonly disk?: { readonly freeBytes: number }
  readonly memory?: { readonly totalBytes: number }
  readonly cast?: { readonly present: boolean; readonly version?: string }
  readonly stake?: StakeProbe
}

/**
 * Whether the worker's own address can afford to register.
 *
 * The one requirement that is neither hardware nor software, and the one the
 * tooling is silent about: registering stakes the minimum as `msg.value`, so an
 * underfunded address fails at the transaction with nothing that says how much
 * was needed. Every other check here can be satisfied while this one is not.
 */
export interface StakeProbe {
  /** From the keystore, since that is the address that will register. */
  readonly address?: string
  /** Wei. `AIConfig.getMinWorkerStake()`, which governance can change. */
  readonly minimum?: bigint
  readonly balance?: bigint
  /** Set when the chain could not be read at all. */
  readonly unreachable?: boolean
  /** Already registered, in which case the stake is posted and this is moot. */
  readonly registered?: boolean
}

export interface DockerProbe {
  /** Whether the daemon answered, not merely whether the CLI exists. */
  readonly daemonRunning: boolean
  readonly version?: string
  readonly cliPresent: boolean
}

export interface OllamaProbe {
  readonly reachable: boolean
  /** Names exactly as `/api/tags` reports them, e.g. `llama3-8b:latest`. */
  readonly models?: readonly string[]
}

export interface GpuProbe {
  readonly detected: boolean
  readonly name?: string
  readonly vramBytes?: number
  /** Apple GPUs share system memory and report no discrete VRAM. */
  readonly unifiedMemory?: boolean
}

function pass(id: string, title: string, detail: string): CheckResult {
  return { id, title, status: 'pass', detail }
}

function warn(id: string, title: string, detail: string, remedy: string): CheckResult {
  return { id, title, status: 'warn', detail, remedy }
}

function fail(id: string, title: string, detail: string, remedy: string): CheckResult {
  return { id, title, status: 'fail', detail, remedy }
}

function checkDocker(probe: DockerProbe | undefined): CheckResult {
  const id = 'docker'
  const title = 'Docker'

  if (!probe) return warn(id, title, 'not probed', 'Run the check again on the worker host.')

  if (!probe.cliPresent) {
    return fail(
      id,
      title,
      'the docker command was not found',
      'Install Docker Desktop 4.30 or newer, or Docker Engine 26 or newer on Linux, then reopen your terminal.'
    )
  }

  if (!probe.daemonRunning) {
    // Toolkit failure mode 8. The CLI existing tells you nothing; every later
    // phase fails with "failed to connect to the Docker daemon" instead.
    return fail(
      id,
      title,
      'the docker command exists but the daemon did not respond',
      'Start Docker Desktop, or run `sudo systemctl start docker` on Linux, and wait for it to report running.'
    )
  }

  return pass(id, title, `daemon running${probe.version ? `, version ${probe.version}` : ''}`)
}

function checkOllama(probe: OllamaProbe | undefined, req: Requirements): CheckResult[] {
  const id = 'ollama'
  const title = 'Ollama'

  if (!probe) {
    return [warn(id, title, 'not probed', 'Run the check again on the worker host.')]
  }

  if (!probe.reachable) {
    // Toolkit failure mode 14: surfaces much later as "connection refused" at
    // inference, by which point a job has already been accepted and lost.
    return [
      fail(
        id,
        title,
        `nothing answered on port ${req.ollamaPort}`,
        'Start Ollama and confirm `curl http://127.0.0.1:11434/api/tags` returns JSON.'
      )
    ]
  }

  const results: CheckResult[] = [pass(id, title, `reachable on port ${req.ollamaPort}`)]
  const tags = probe.models ?? []

  for (const model of req.requiredModels) {
    const exact = tags.includes(model)
    const tagged = tags.includes(`${model}:latest`)

    if (exact) {
      results.push(pass(`model:${model}`, `Model ${model}`, 'present'))
      continue
    }

    if (tagged) {
      // Toolkit failure modes 1 and 2. This works, but the worker logs a
      // verification warning that reliably gets reported as a fault. Saying so
      // here is cheaper than answering it later.
      results.push(
        pass(
          `model:${model}`,
          `Model ${model}`,
          `present as ${model}:latest. The worker will log "ollama model verification failed" at startup; that warning is benign and inference will work.`
        )
      )
      continue
    }

    results.push(
      fail(
        `model:${model}`,
        `Model ${model}`,
        `not present. Ollama reports: ${tags.length ? tags.join(', ') : 'no models at all'}`,
        `Run \`ollama pull llama3:8b\` then \`ollama cp llama3:8b ${model}\`. The alias matters: the name must match SUPPORTED_MODELS or the worker cannot resolve queued jobs.`
      )
    )
  }

  return results
}

function checkGpu(probe: GpuProbe | undefined, req: Requirements): CheckResult {
  const id = 'gpu'
  const title = 'GPU'

  if (!probe) return warn(id, title, 'not probed', 'Run the check again on the worker host.')

  if (probe.unifiedMemory) {
    return pass(
      id,
      title,
      `${probe.name ?? 'Apple GPU'} with unified memory; VRAM is shared with system RAM`
    )
  }

  if (!probe.detected) {
    return fail(
      id,
      title,
      'no GPU detected',
      `A GPU with at least ${formatBytes(req.minVramBytes)} of VRAM is required. CPU-only inference is too slow to complete jobs before they time out.`
    )
  }

  if (probe.vramBytes === undefined) {
    return warn(
      id,
      title,
      `${probe.name ?? 'GPU'} detected but VRAM could not be read`,
      `Confirm manually that it has at least ${formatBytes(req.minVramBytes)}.`
    )
  }

  if (probe.vramBytes < req.minVramBytes) {
    return fail(
      id,
      title,
      `${probe.name ?? 'GPU'} has ${formatBytes(probe.vramBytes)}`,
      `At least ${formatBytes(req.minVramBytes)} is required. The model will not fit and inference will fail after the job is accepted.`
    )
  }

  return pass(id, title, `${probe.name ?? 'GPU'} with ${formatBytes(probe.vramBytes)}`)
}

function checkDisk(probe: { freeBytes: number } | undefined, req: Requirements): CheckResult {
  const id = 'disk'
  const title = 'Disk space'
  if (!probe) return warn(id, title, 'not probed', 'Run the check again on the worker host.')

  if (probe.freeBytes < req.minFreeDiskBytes) {
    return fail(
      id,
      title,
      `${formatBytes(probe.freeBytes)} free`,
      `At least ${formatBytes(req.minFreeDiskBytes)} is required for the worker image and model weights.`
    )
  }
  return pass(id, title, `${formatBytes(probe.freeBytes)} free`)
}

function checkMemory(probe: { totalBytes: number } | undefined, req: Requirements): CheckResult {
  const id = 'memory'
  const title = 'System memory'
  if (!probe) return warn(id, title, 'not probed', 'Run the check again on the worker host.')

  if (probe.totalBytes < req.minRamBytes) {
    return warn(
      id,
      title,
      `${formatBytes(probe.totalBytes)} total`,
      `${formatBytes(req.minRamBytes)} is the documented minimum. Less may work but will be slower under load.`
    )
  }
  return pass(id, title, `${formatBytes(probe.totalBytes)} total`)
}

function checkCast(probe: { present: boolean; version?: string } | undefined): CheckResult {
  const id = 'cast'
  const title = 'Foundry cast'
  if (!probe) return warn(id, title, 'not probed', 'Run the check again on the worker host.')

  if (!probe.present) {
    // Toolkit failure mode 10, and usually a stale shell rather than a missing
    // install, which is why the remedy says so.
    return fail(
      id,
      title,
      'not found on PATH',
      'Install Foundry, then open a new terminal. An existing shell keeps the old PATH, so a fresh install often looks missing until you reopen it.'
    )
  }
  return pass(id, title, `available${probe.version ? `, version ${probe.version}` : ''}`)
}

/** Wei to a readable amount. Whole numbers stay whole; the rest keep four places. */
function lcai(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  return fraction === '' ? `${whole}` : `${whole}.${fraction}`
}

function checkStake(probe: StakeProbe | undefined): CheckResult[] {
  const id = 'stake'
  const title = 'Stake'

  // Only meaningful once there is a keystore. Before that the operator has no
  // address to fund, and saying so twice helps nobody.
  if (!probe?.address) return []

  if (probe.registered) {
    return [pass(id, title, `${probe.address} is registered and its stake is posted`)]
  }

  if (probe.unreachable || probe.minimum === undefined || probe.balance === undefined) {
    return [
      warn(
        id,
        title,
        'could not read the chain, so the stake requirement is unknown',
        'Check the network setting and that the RPC is reachable. Registering without enough to stake fails at the transaction.'
      )
    ]
  }

  // Gas is paid from the same balance, because LCAI is the native token — so a
  // wallet holding exactly the minimum cannot register.
  if (probe.balance <= probe.minimum) {
    const short = probe.minimum - probe.balance
    return [
      fail(
        id,
        title,
        `${probe.address} holds ${lcai(probe.balance)} LCAI, and registering stakes ${lcai(probe.minimum)} LCAI`,
        `Send at least ${lcai(short + 10n ** 18n)} more LCAI to that address. The stake is the transaction's value and gas comes out of the same balance, so holding exactly ${lcai(probe.minimum)} LCAI is not enough.`
      )
    ]
  }

  return [
    pass(
      id,
      title,
      `${probe.address} holds ${lcai(probe.balance)} LCAI; registering will stake ${lcai(probe.minimum)} LCAI`
    )
  ]
}

export function runChecks(
  probes: Probes,
  requirements: Requirements = DEFAULT_REQUIREMENTS
): CheckResult[] {
  return [
    checkDocker(probes.docker),
    ...checkOllama(probes.ollama, requirements),
    checkGpu(probes.gpu, requirements),
    checkMemory(probes.memory, requirements),
    checkDisk(probes.disk, requirements),
    checkCast(probes.cast),
    ...checkStake(probes.stake)
  ]
}

/** True when nothing failed. Warnings do not block a worker from starting. */
export function isReady(results: readonly CheckResult[]): boolean {
  return !results.some((r) => r.status === 'fail')
}

export function summarize(results: readonly CheckResult[]): {
  ready: boolean
  passed: number
  warned: number
  failed: number
} {
  return {
    ready: isReady(results),
    passed: results.filter((r) => r.status === 'pass').length,
    warned: results.filter((r) => r.status === 'warn').length,
    failed: results.filter((r) => r.status === 'fail').length
  }
}
