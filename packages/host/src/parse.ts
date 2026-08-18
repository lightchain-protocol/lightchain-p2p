import type { DockerProbe, GpuProbe, OllamaProbe } from '@lcai-p2p/preflight'

/**
 * Turning command output into facts.
 *
 * Separated from the commands themselves for the same reason
 * [`@lcai-p2p/preflight`](../preflight) is separate from this package: the
 * judgement can then be tested without the hardware. Every function here is
 * pure, so an Apple GPU, a missing Docker daemon and a full disk are all
 * reachable from a test on any machine.
 *
 * All of them accept `null` for "the command did not run", which is different
 * from "the command ran and reported nothing" and must not be conflated: an
 * unreadable host is not a bad one.
 */

/**
 * Docker from `--version` and `version --format {{.Server.Version}}`.
 *
 * The two are asked separately on purpose. `--version` is answered by the CLI
 * alone and says nothing about the daemon, and confusing "installed" with
 * "running" is the most common onboarding failure.
 */
export function parseDocker(cli: string | null, server: string | null): DockerProbe {
  if (cli === null) return { cliPresent: false, daemonRunning: false }
  if (server === null || server === '') return { cliPresent: true, daemonRunning: false }
  return { cliPresent: true, daemonRunning: true, version: server }
}

/** GPU from `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string | null): GpuProbe {
  if (output === null || output.trim() === '') return { detected: false }

  const first = output.trim().split('\n')[0] ?? ''
  const [name, mib] = first.split(',').map((part) => part.trim())
  if (!name) return { detected: false }

  const megabytes = Number(mib)
  if (!Number.isFinite(megabytes) || megabytes <= 0) return { detected: true, name }

  return { detected: true, name, vramBytes: megabytes * 1024 * 1024 }
}

/**
 * Apple silicon from `sysctl -n machdep.cpu.brand_string`.
 *
 * Reported without a VRAM figure because the GPU shares system memory, so
 * there is no discrete number to hold against a floor. Returns null when the
 * chip is not Apple, leaving the caller to fall through to nvidia-smi.
 */
export function parseAppleChip(output: string | null): GpuProbe | null {
  if (output === null) return null
  const chip = output.trim()
  if (chip === '' || !/Apple/i.test(chip)) return null
  return { detected: true, name: chip, unifiedMemory: true }
}

/** Free bytes from `df -k <path>`. */
export function parseDf(output: string | null): number | undefined {
  if (output === null) return undefined

  const last = output.trim().split('\n').at(-1)
  if (!last) return undefined

  const kilobytes = Number(last.split(/\s+/)[3])
  if (!Number.isFinite(kilobytes) || kilobytes < 0) return undefined

  return kilobytes * 1024
}

/** Free bytes from PowerShell's `(Get-PSDrive C).Free`. */
export function parseWindowsFree(output: string | null): number | undefined {
  if (output === null) return undefined
  const bytes = Number(output.trim())
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined
}

/** Version from `cast --version`. */
export function parseCast(output: string | null): { present: boolean; version?: string } {
  if (output === null) return { present: false }
  const version = /(\d+\.\d+\.\d+)/.exec(output)?.[1]
  return version === undefined ? { present: true } : { present: true, version }
}

/** Ollama's `/api/tags` body. Shape is not guaranteed, so nothing is assumed. */
export function parseOllamaTags(body: unknown): OllamaProbe {
  const models = (body as { models?: unknown })?.models
  if (!Array.isArray(models)) return { reachable: true, models: [] }

  return {
    reachable: true,
    models: models
      .map((m) => (m as { name?: unknown })?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '')
  }
}
