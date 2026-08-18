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
  parseWindowsFree
} from './parse.js'
import { outputAsync } from './run.js'

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
  const [docker, ollama, gpu, disk, cast] = await Promise.all([
    probeDocker(),
    probeOllama(ollamaPort),
    probeGpu(),
    probeDisk(diskPath),
    probeCast()
  ])

  return { docker, ollama, gpu, memory: probeMemory(), disk, cast }
}
