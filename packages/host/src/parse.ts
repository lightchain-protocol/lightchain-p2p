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

/**
 * The client version out of `ollama --version`.
 *
 * Given the command's combined output rather than its stdout, because the
 * command answers with the client version *and* exits non-zero when no server
 * is listening — which is exactly the state we most want to tell apart from
 * "not installed". Judging that by exit status alone reports a working
 * installation as an absent one.
 */
export function parseOllamaVersion(output: string | null): string | undefined {
  if (output === null) return undefined
  const match = /version\s+(?:is\s+)?v?(\d[^\s]*)/i.exec(output)
  return match ? match[1] : undefined
}

/**
 * A progress-bar stream, made readable in a pane that is not a terminal.
 *
 * `ollama pull` draws several gigabytes of download as one line it rewrites
 * with carriage returns and colours with ANSI escapes. Appended verbatim to an
 * element's textContent, none of that is interpreted: the escapes show up as
 * literal `[?25l` noise and every rewrite lands beside the last, so a single
 * pull produces one unreadable line thousands of characters wide.
 *
 * This keeps only what each rewritten line settled on and drops the escapes,
 * which is the whole of what a log pane can honestly show. It is not a terminal
 * emulator and does not try to be one — a chunk that ends mid-line is resolved
 * as what arrived, and the next chunk continues from there.
 */
export function plainText(chunk: string): string {
  // CSI sequences (colour, cursor moves, the hide/show-cursor pair Ollama
  // brackets its progress with) and lone bare escapes.
  //
  // The rule against control characters in a pattern is asking whether one got
  // in by accident. Here they are the subject: this function exists to take
  // escapes out of text that is about to be rendered as literal characters.
  // eslint-disable-next-line no-control-regex
  const stripped = chunk.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001B/g, '')

  return stripped
    .split('\n')
    .map((line) => {
      const rewrites = line.split('\r')
      return rewrites[rewrites.length - 1] ?? ''
    })
    .join('\n')
}
