import { spawnSync } from 'bare-subprocess'
import os from 'bare-os'

/**
 * Observes the host. All the I/O lives here; the judgement lives in
 * @lcai-p2p/preflight, which is why that half can be tested without a GPU.
 *
 * Every probe fails soft. A probe that throws returns undefined, which the
 * checks report as "not probed" — a warning rather than a false verdict. An
 * unreadable host is not the same as a bad one and should not be reported as one.
 */

const GIB = 1024 ** 3

function run(file, args, { timeout = 10_000 } = {}) {
  try {
    const res = spawnSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout })
    if (res.error || res.status !== 0) return null
    return res.stdout ? res.stdout.toString().trim() : ''
  } catch {
    return null
  }
}

export function probeDocker() {
  try {
    const cli = run('docker', ['--version'])
    if (cli === null) return { cliPresent: false, daemonRunning: false }

    // --version answers from the CLI alone and says nothing about the daemon.
    // Asking for the *server* version is what distinguishes "installed" from
    // "running", and that distinction is the most common onboarding failure.
    const server = run('docker', ['version', '--format', '{{.Server.Version}}'])
    if (server === null) return { cliPresent: true, daemonRunning: false }

    return { cliPresent: true, daemonRunning: true, version: server }
  } catch {
    return undefined
  }
}

export async function probeOllama(port = 11434) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return { reachable: false }

    const body = await res.json()
    const models = Array.isArray(body?.models) ? body.models.map((m) => m.name).filter(Boolean) : []
    return { reachable: true, models }
  } catch {
    return { reachable: false }
  }
}

export function probeGpu() {
  try {
    if (os.platform() === 'darwin') {
      const chip = run('sysctl', ['-n', 'machdep.cpu.brand_string'])
      // Apple silicon shares memory with the system, so there is no discrete
      // VRAM figure to compare against a floor.
      if (chip && /Apple/i.test(chip)) return { detected: true, name: chip, unifiedMemory: true }
    }

    const smi = run('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits'
    ])
    if (smi === null || smi === '') return { detected: false }

    const [name, mib] = smi
      .split('\n')[0]
      .split(',')
      .map((s) => s.trim())
    const megabytes = Number(mib)
    if (!Number.isFinite(megabytes)) return { detected: true, name }

    return { detected: true, name, vramBytes: megabytes * 1024 * 1024 }
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

export function probeDisk(path) {
  try {
    if (os.platform() === 'win32') {
      const drive = (path || 'C:').slice(0, 2)
      const out = run('powershell', ['-NoProfile', '-Command', `(Get-PSDrive ${drive[0]}).Free`])
      const free = Number(out)
      return Number.isFinite(free) && free > 0 ? { freeBytes: free } : undefined
    }

    const out = run('df', ['-k', path || '.'])
    if (!out) return undefined
    const line = out.split('\n').at(-1)
    const available = Number(line.split(/\s+/)[3])
    return Number.isFinite(available) ? { freeBytes: available * 1024 } : undefined
  } catch {
    return undefined
  }
}

export function probeCast() {
  const out = run('cast', ['--version'])
  if (out === null) return { present: false }
  const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  return version ? { present: true, version } : { present: true }
}

export async function probeAll({ ollamaPort = 11434, diskPath } = {}) {
  return {
    docker: probeDocker(),
    ollama: await probeOllama(ollamaPort),
    gpu: probeGpu(),
    memory: probeMemory(),
    disk: probeDisk(diskPath),
    cast: probeCast()
  }
}

export { GIB }
