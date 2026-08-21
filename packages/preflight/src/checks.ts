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

/**
 * What would fix a check, where fixing it is something an application can
 * offer to do rather than describe.
 *
 * Named here rather than inferred by a caller reading `remedy`, because the
 * distinction that matters most — Docker absent against Docker not running,
 * Ollama absent against Ollama not running — is invisible in a sentence and
 * costly to get wrong: an interface that offers "Start Docker" to somebody who
 * has never installed it sends them to press a button that cannot work. The
 * judgement is made once, here, where it is tested.
 */
export type CheckAction =
  | 'install-docker'
  | 'start-docker'
  | 'install-ollama'
  | 'start-ollama'
  | 'fetch-model'
  | 'choose-models'

export interface CheckResult {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  /** What was observed. */
  readonly detail: string
  /** What to do about it. Present whenever the status is not a pass. */
  readonly remedy?: string
  /**
   * The offer that goes with the remedy, where there is one. Absent means the
   * remedy is the whole of what we can say — a GPU cannot be installed by
   * pressing a button.
   */
  readonly action?: CheckAction
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
  /**
   * Whether the `ollama` command exists, which is not the same question.
   *
   * An unreachable port means one of two very different things — nothing is
   * installed, or it is installed and not running — and they have different
   * remedies. Undefined where the CLI was not probed.
   */
  readonly cliPresent?: boolean
  readonly cliVersion?: string
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

function fail(
  id: string,
  title: string,
  detail: string,
  remedy: string,
  action?: CheckAction
): CheckResult {
  return action === undefined
    ? { id, title, status: 'fail', detail, remedy }
    : { id, title, status: 'fail', detail, remedy, action }
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
      'Install Docker Desktop 4.30 or newer, or Docker Engine 26 or newer on Linux, then reopen your terminal.',
      'install-docker'
    )
  }

  if (!probe.daemonRunning) {
    // Toolkit failure mode 8. The CLI existing tells you nothing; every later
    // phase fails with "failed to connect to the Docker daemon" instead.
    return fail(
      id,
      title,
      'the docker command exists but the daemon did not respond',
      'Start Docker Desktop, or run `sudo systemctl start docker` on Linux, and wait for it to report running.',
      'start-docker'
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
    //
    // Split by whether the command exists, because "install it" and "start it"
    // are different jobs and one remedy covering both sends half its readers
    // to the wrong place.
    return [
      probe.cliPresent === false
        ? fail(
            id,
            title,
            'Ollama is not installed',
            'Install Ollama, the runtime that answers the inference jobs this worker is paid for. The Earn page can open the download for you.',
            'install-ollama'
          )
        : fail(
            id,
            title,
            probe.cliPresent === true
              ? `Ollama is installed but nothing answered on port ${req.ollamaPort}`
              : `nothing answered on port ${req.ollamaPort}`,
            'Start Ollama — the Earn page has a button for it — and it will answer on port 11434.',
            'start-ollama'
          )
    ]
  }

  const results: CheckResult[] = [pass(id, title, `reachable on port ${req.ollamaPort}`)]
  const tags = probe.models ?? []

  // A worker that has chosen no models is not a misconfigured worker so much as
  // an unfinished one: it would start, connect, and be offered nothing, which
  // looks exactly like a network with no demand. Which models it could choose
  // from is the network's list, not ours, so this asks rather than assumes.
  if (req.requiredModels.length === 0) {
    results.push(
      fail(
        'models',
        'Models',
        'none chosen',
        'Choose which of the models this network whitelists this machine will answer for. Bigger models pay more per job and need more VRAM.',
        'choose-models'
      )
    )
    return results
  }

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
        `The Earn page can fetch it — several gigabytes, once. It pulls the upstream tag and then names a copy ${model}, and that second half is what matters: the name has to match SUPPORTED_MODELS or the worker cannot resolve queued jobs.`,
        'fetch-model'
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
