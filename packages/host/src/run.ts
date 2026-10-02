import { spawn, spawnSync } from 'child_process'
import os from 'os'

/**
 * Running host commands.
 *
 * `child_process` resolves to `bare-subprocess` under Bare and to Node's own
 * elsewhere, through the `imports` map in `package.json`, so the same source
 * serves the terminal supervisor, the desktop app and the tests.
 */

export interface CommandResult {
  readonly ok: boolean
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  /** Milliseconds. `0` means no limit, for pulls and container starts. */
  readonly timeout?: number
  /**
   * Called with output as it arrives, as well as collected into the result.
   *
   * `docker pull` runs for minutes and says a great deal while it does. Without
   * this the only honest thing an interface can show is a spinner, and a
   * spinner that has been turning for four minutes is indistinguishable from
   * one that is stuck.
   */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  /**
   * Variables added to the child's environment, over this process's own.
   *
   * For secrets: a command line is readable by every local user, an
   * environment only by the process's owner.
   */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * This process's environment plus `extra`, or undefined to inherit unchanged.
 *
 * Passing `env` to spawn replaces the environment rather than adding to it, and
 * a `docker` without PATH or DOCKER_HOST cannot find its daemon. Node has
 * `process.env`; Bare may have no `process` global, and exposes the same
 * through `bare-os`, which is what `os` resolves to there.
 */
function childEnv(extra: RunOptions['env']): Record<string, string> | undefined {
  if (!extra) return undefined
  const own: Record<string, string> = {}
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc?.env) {
    for (const [key, value] of Object.entries(proc.env)) {
      if (value !== undefined) own[key] = value
    }
  } else {
    const bare = os as unknown as { getEnvKeys?: () => string[]; getEnv?: (key: string) => string }
    for (const key of bare.getEnvKeys?.() ?? []) own[key] = bare.getEnv!(key)
  }
  return { ...own, ...extra }
}

/**
 * Runs a command and collects its output.
 *
 * Never throws and never inherits stdio. Both matter: a probe that throws on a
 * missing binary would report an unreadable host as a broken one, and inherited
 * stdio would print a Docker argv that carries the keystore password.
 */
export function run(file: string, args: readonly string[], opts: RunOptions = {}): CommandResult {
  try {
    const limit = opts.timeout ?? 10_000
    const res = spawnSync(file, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(opts.env),
      // Passed as undefined rather than 0, because a runtime that reads 0 as
      // "expire immediately" would kill every long command on contact.
      timeout: limit > 0 ? limit : undefined
    })

    return {
      ok: !res.error && res.status === 0,
      status: res.status ?? null,
      stdout: res.stdout ? res.stdout.toString() : '',
      stderr: res.stderr ? res.stderr.toString() : ''
    }
  } catch (err) {
    return { ok: false, status: null, stdout: '', stderr: (err as Error).message }
  }
}

/** Trimmed stdout, or null when the command did not run or failed. */
export function output(
  file: string,
  args: readonly string[],
  opts: RunOptions = {}
): string | null {
  const res = run(file, args, opts)
  return res.ok ? res.stdout.trim() : null
}

/**
 * The same, without blocking.
 *
 * `run` stops the thread until the command exits, which is fine in a terminal
 * that has nothing else to do. It is not fine in the desktop worker, where the
 * same thread is replicating rooms — a Docker call would freeze the
 * conversation for as long as it took, and `docker pull` takes minutes.
 */
export function runAsync(
  file: string,
  args: readonly string[],
  opts: RunOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(opts.env) })
    } catch (err) {
      resolve({ ok: false, status: null, stdout: '', stderr: (err as Error).message })
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false

    const limit = opts.timeout ?? 10_000
    const timer =
      limit > 0
        ? setTimeout(() => {
            // Resolved by the 'close' that killing provokes, so a timeout and a
            // crash take the same path out.
            child.kill()
          }, limit)
        : null
    timer?.unref?.()

    const finish = (result: CommandResult) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout += text
      opts.onOutput?.(text, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      // Docker writes its progress to stderr, so this is the interesting one.
      opts.onOutput?.(text, 'stderr')
    })

    // A missing binary arrives here rather than as a throw from spawn.
    child.on('error', (err: Error) => {
      finish({ ok: false, status: null, stdout, stderr: stderr || err.message })
    })

    child.on('close', (code: number | null) => {
      finish({ ok: code === 0, status: code, stdout, stderr })
    })
  })
}

/** Trimmed stdout, or null when the command did not run or failed. */
export async function outputAsync(
  file: string,
  args: readonly string[],
  opts: RunOptions = {}
): Promise<string | null> {
  const res = await runAsync(file, args, opts)
  return res.ok ? res.stdout.trim() : null
}
