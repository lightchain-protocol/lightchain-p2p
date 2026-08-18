import { describe, expect, it } from 'vitest'
import {
  parseAppleChip,
  parseCast,
  parseDf,
  parseDocker,
  parseNvidiaSmi,
  parseOllamaTags,
  parseWindowsFree
} from './index.js'

describe('docker', () => {
  it('separates an installed CLI from a running daemon', () => {
    // The distinction the whole probe exists for. `docker --version` answers
    // from the CLI alone, so treating it as proof the daemon is up produces the
    // most common onboarding failure several steps later.
    expect(parseDocker('Docker version 27.3.1, build ce12230', '27.3.1')).toEqual({
      cliPresent: true,
      daemonRunning: true,
      version: '27.3.1'
    })

    expect(parseDocker('Docker version 27.3.1, build ce12230', null)).toEqual({
      cliPresent: true,
      daemonRunning: false
    })

    expect(parseDocker(null, null)).toEqual({ cliPresent: false, daemonRunning: false })
  })

  it('treats empty server output as a daemon that did not answer', () => {
    expect(parseDocker('Docker version 27.3.1', '')).toEqual({
      cliPresent: true,
      daemonRunning: false
    })
  })
})

describe('gpu', () => {
  it('reads a name and VRAM from nvidia-smi', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564')).toEqual({
      detected: true,
      name: 'NVIDIA GeForce RTX 4090',
      vramBytes: 24564 * 1024 * 1024
    })
  })

  it('takes the first GPU when a host has several', () => {
    const two = 'NVIDIA A100-SXM4-40GB, 40960\nNVIDIA A100-SXM4-40GB, 40960'
    expect(parseNvidiaSmi(two).name).toBe('NVIDIA A100-SXM4-40GB')
  })

  it('reports a GPU without VRAM rather than a wrong number', () => {
    // Better to warn that VRAM is unknown than to compare NaN against the floor
    // and silently decide the host is fine.
    expect(parseNvidiaSmi('Some GPU, [N/A]')).toEqual({ detected: true, name: 'Some GPU' })
  })

  it('reports nothing detected when nvidia-smi is absent or silent', () => {
    expect(parseNvidiaSmi(null)).toEqual({ detected: false })
    expect(parseNvidiaSmi('')).toEqual({ detected: false })
  })

  it('recognises Apple silicon and omits VRAM deliberately', () => {
    // Apple GPUs share system memory, so there is no discrete figure to hold
    // against a floor and inventing one would be worse than omitting it.
    expect(parseAppleChip('Apple M3 Max')).toEqual({
      detected: true,
      name: 'Apple M3 Max',
      unifiedMemory: true
    })
  })

  it('falls through on an Intel Mac so nvidia-smi still gets a turn', () => {
    expect(parseAppleChip('Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz')).toBeNull()
    expect(parseAppleChip(null)).toBeNull()
  })
})

describe('disk', () => {
  it('reads available kilobytes from df and converts to bytes', () => {
    const df = [
      'Filesystem     1K-blocks      Used Available Use% Mounted on',
      '/dev/nvme0n1p2 982940472 402183928 530800000  44% /'
    ].join('\n')

    expect(parseDf(df)).toBe(530800000 * 1024)
  })

  it('reads free bytes from PowerShell', () => {
    expect(parseWindowsFree('412316860416')).toBe(412316860416)
  })

  it('returns undefined rather than zero when it cannot tell', () => {
    // Zero would read as a full disk and fail the check. Undefined is reported
    // as "not probed", which is the truth.
    expect(parseDf(null)).toBeUndefined()
    expect(parseDf('Filesystem 1K-blocks Used Available Use% Mounted')).toBeUndefined()
    expect(parseWindowsFree('')).toBeUndefined()
    expect(parseWindowsFree('not a number')).toBeUndefined()
  })
})

describe('cast', () => {
  it('extracts a version when there is one', () => {
    expect(parseCast('cast 0.2.0 (fdd321b 2024-11-08T00:22:20.786754000Z)')).toEqual({
      present: true,
      version: '0.2.0'
    })
  })

  it('reports presence without a version rather than absence', () => {
    expect(parseCast('cast (unknown build)')).toEqual({ present: true })
    expect(parseCast(null)).toEqual({ present: false })
  })
})

describe('ollama', () => {
  it('lists model names exactly as reported', () => {
    const body = { models: [{ name: 'llama3:8b' }, { name: 'mistral:latest' }] }
    expect(parseOllamaTags(body)).toEqual({
      reachable: true,
      models: ['llama3:8b', 'mistral:latest']
    })
  })

  it('survives a body that is not the shape it should be', () => {
    // A reachable Ollama with an unreadable body is still reachable, and
    // throwing here would report the whole host as unprobeable.
    expect(parseOllamaTags({})).toEqual({ reachable: true, models: [] })
    expect(parseOllamaTags(null)).toEqual({ reachable: true, models: [] })
    expect(parseOllamaTags({ models: 'nope' })).toEqual({ reachable: true, models: [] })
    expect(parseOllamaTags({ models: [{ name: 1 }, {}, { name: 'ok' }] })).toEqual({
      reachable: true,
      models: ['ok']
    })
  })
})
