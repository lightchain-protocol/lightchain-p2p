import os from 'os'
import fetch from '#fetch'
import type { Probes } from '@lcai-p2p/preflight'
import {
  parseAppleChip,
  parseCast,
  parseDf,
  parseDocker,
  parseNvidiaSmi,
  parseOllamaTags,
  parseOllamaVersion,
  parseWindowsFree
} from './parse.js'
import { outputAsync, runAsync } from './run.js'

/**
 * Observing the host.
 *
 * All the I/O is here and all the interpretation is in `parse.ts`, which is why
 * the interpretation can be tested on a machine with no GPU and no Docker.
 *
 * Every probe fails soft: anything that throws returns `undefined`, which
 * `@lcai-p2p/preflight` reports as "not probed" — a warning rather than a
 * verdict. A host we cannot read is not the same as a host that cannot work.
 *
 * Nothing here blocks. These run inside the desktop worker alongside room
 * replication, and a synchronous `nvidia-smi` would stall the conversation.
 */

export interface ProbeOptions {
  readonly ollamaPort?: number
  readonly diskPath?: string
}

export async function probeDocker() {
  try {
    return parseDocker(
      await outputAsync('docker', ['--version']),
      await outputAsync('docker', ['version', '--format', '{{.Server.Version}}'])
    )
  } catch {
    return undefined
  }
}

export async function probeGpu() {
  try {
    if (os.platform() === 'darwin') {
      const apple = parseAppleChip(await outputAsync('sysctl', ['-n', 'machdep.cpu.brand_string']))
      if (apple) return apple
    }

    return parseNvidiaSmi(
      await outputAsync('nvidia-smi', [
        '--query-gpu=name,memory.total',
        '--format=csv,noheader,nounits'
      ])
    )
  } catch {
    return undefined
  }
}

/**
 * Which platform this is.
 *
 * Lives here rather than in the application because `os` is the one builtin
 * that differs between the runtimes: under Bare it is a native addon, and an
 * application that imports `bare-os` directly cannot be loaded by a test
 * runner at all. This package's `imports` map already resolves it for both, so
 * asking through the package is the only way to ask once.
 */
export function hostPlatform(): string {
  return os.platform()
}

export function probeMemory() {
  try {
    return { totalBytes: os.totalmem() }
  } catch {
    return undefined
  }
}

export async function probeDisk(path?: string) {
  try {
    if (os.platform() === 'win32') {
      const drive = (path ?? 'C:').slice(0, 1)
      const free = parseWindowsFree(
        await outputAsync('powershell', ['-NoProfile', '-Command', `(Get-PSDrive ${drive}).Free`], {
          timeout: 15_000
        })
      )
      return free === undefined ? undefined : { freeBytes: free }
    }

    const free = parseDf(await outputAsync('df', ['-k', path ?? '.']))
    return free === undefined ? undefined : { freeBytes: free }
  } catch {
    return undefined
  }
}

export async function probeCast() {
  try {
    return parseCast(await outputAsync('cast', ['--version']))
  } catch {
    return undefined
  }
}

/**
 * Whether the `ollama` command exists, asked separately from whether it is
 * serving — the same split `probeDocker` makes between the CLI and the daemon,
 * and for the same reason: one of those is fixed by installing something and
 * the other by starting it.
 */
export async function probeOllamaCli() {
  try {
    const res = await runAsync('ollama', ['--version'])
    // A missing binary arrives as an ENOENT in stderr with no status, which
    // parses to no version and did not succeed — the one branch that is a
    // confident "absent". Anything that ran and said nothing we recognise is
    // reported as present, since it did run.
    const version = parseOllamaVersion(`${res.stdout}\n${res.stderr}`)
    if (version !== undefined) return { present: true, version }
    return { present: res.ok }
  } catch {
    return undefined
  }
}

export async function probeOllama(port = 11434) {
  try {
    // Raced rather than aborted: Bare has no AbortController either, and a
    // probe that answers is worth more than a socket closed a little sooner.
    let timer: ReturnType<typeof setTimeout> | undefined
    const res = await Promise.race([
      fetch(`http://127.0.0.1:${port}/api/tags`),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5000)
        timer.unref?.()
      })
    ])
    clearTimeout(timer)

    if (!res || !res.ok) return { reachable: false }
    return parseOllamaTags(await res.json())
  } catch {
    return { reachable: false }
  }
}

export async function probeAll({
  ollamaPort = 11434,
  diskPath
}: ProbeOptions = {}): Promise<Probes> {
  // In parallel: they are independent, and run one after another the slowest
  // sets the wait for all of them.
  const [docker, ollama, ollamaCli, gpu, disk, cast] = await Promise.all([
    probeDocker(),
    probeOllama(ollamaPort),
    probeOllamaCli(),
    probeGpu(),
    probeDisk(diskPath),
    probeCast()
  ])

  return {
    docker,
    // The two Ollama questions arrive as one probe, because one check answers
    // for both and it needs to know the difference to say the right thing.
    ollama: { ...ollama, cliPresent: ollamaCli?.present, cliVersion: ollamaCli?.version },
    gpu,
    memory: probeMemory(),
    disk,
    cast
  }
}
