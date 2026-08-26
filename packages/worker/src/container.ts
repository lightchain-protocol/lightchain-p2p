/**
 * Reads `docker inspect` output and says what it means.
 *
 * `--restart always` makes a broken worker look alive: the container is
 * running, `docker ps` is happy, and it is in fact crashing and being restarted
 * every few seconds. The toolkit lists that as a failure mode and leaves the
 * operator to notice a climbing RestartCount by eye.
 */

export type ContainerHealth = 'absent' | 'running' | 'restart-loop' | 'stopped' | 'exited-error'

export interface ContainerState {
  readonly health: ContainerHealth
  readonly running: boolean
  readonly restartCount: number
  readonly exitCode?: number
  readonly startedAt?: string
  readonly detail: string
  readonly remedy?: string
}

/** How many restarts before we call it a loop rather than a hiccup. */
const RESTART_LOOP_THRESHOLD = 3

interface InspectShape {
  State?: {
    Running?: boolean
    Restarting?: boolean
    ExitCode?: number
    StartedAt?: string
    Error?: string
  }
  RestartCount?: number
}

/**
 * @param raw The JSON array printed by `docker inspect <name>`, or null when the
 * command failed because no such container exists.
 */
export function parseContainerState(raw: string | null): ContainerState {
  if (raw === null || raw.trim() === '') {
    return {
      health: 'absent',
      running: false,
      restartCount: 0,
      detail: 'no worker container exists',
      remedy: 'Run the worker to create it.'
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      health: 'absent',
      running: false,
      restartCount: 0,
      detail: 'could not parse docker inspect output',
      remedy: 'Check that the Docker daemon is running and try again.'
    }
  }

  // `Array.isArray` narrows to `any[]`, so indexing it hands back `any` and
  // everything read off the entry afterwards is unchecked. Saying what the
  // array holds is what keeps the rest of this function honest.
  const entry: InspectShape | undefined = Array.isArray(parsed)
    ? (parsed as InspectShape[])[0]
    : (parsed as InspectShape)
  if (!entry?.State) {
    return {
      health: 'absent',
      running: false,
      restartCount: 0,
      detail: 'docker inspect returned no container state',
      remedy: 'Run the worker to create it.'
    }
  }

  const running = entry.State.Running === true
  const restartCount = entry.RestartCount ?? 0
  const exitCode = entry.State.ExitCode
  const startedAt = entry.State.StartedAt

  if (running && restartCount >= RESTART_LOOP_THRESHOLD) {
    // The dangerous case: alive by every casual measure, and doing no work.
    return {
      health: 'restart-loop',
      running: true,
      restartCount,
      exitCode,
      startedAt,
      detail: `container is running but has restarted ${restartCount} times`,
      remedy:
        'Read the logs. A restart loop is almost always a bad keystore password, a chain ID that does not match the network, or an unreachable RPC endpoint — the container will keep coming back and never take a job.'
    }
  }

  if (running) {
    return {
      health: 'running',
      running: true,
      restartCount,
      startedAt,
      detail: restartCount > 0 ? `running, ${restartCount} restarts so far` : 'running'
    }
  }

  if (entry.State.Restarting === true) {
    return {
      health: 'restart-loop',
      running: false,
      restartCount,
      exitCode,
      detail: 'container is mid-restart',
      remedy: 'Read the logs to find why it is not staying up.'
    }
  }

  if (typeof exitCode === 'number' && exitCode !== 0) {
    return {
      health: 'exited-error',
      running: false,
      restartCount,
      exitCode,
      detail: `container exited with code ${exitCode}${entry.State.Error ? `: ${entry.State.Error}` : ''}`,
      remedy: 'Read the logs for the cause, then start the worker again.'
    }
  }

  return {
    health: 'stopped',
    running: false,
    restartCount,
    exitCode,
    detail: 'container exists but is stopped',
    remedy: 'Start the worker.'
  }
}

/** True when the worker is up and not thrashing. */
export function isHealthy(state: ContainerState): boolean {
  return state.health === 'running'
}
