import { describe, expect, it } from 'vitest'

import { DEFAULT_REQUIREMENTS, GIB } from './requirements.js'
import { estimateFootprint, fetchFootprint, fits, requirementsForModels } from './sizing.js'

function registry(sizes: Record<string, number[]>) {
  return async (url: string) => {
    const match = /\/library\/(.+)\/manifests\/(.+)$/.exec(url)
    const reference = match ? `${match[1]}:${match[2]}` : ''
    const layers = sizes[reference]
    if (!layers) return { ok: false, status: 404, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ layers: layers.map((size) => ({ size })) })
    }
  }
}

describe('estimateFootprint', () => {
  it('reads a parameter count out of either spelling', () => {
    expect(estimateFootprint('llama3-8b')?.weightsBytes).toBeCloseTo(8e9 * 0.6, -6)
    expect(estimateFootprint('gpt-oss:20b')?.weightsBytes).toBeCloseTo(20e9 * 0.6, -6)
  })

  it('declines to invent a size for a name that carries none', () => {
    // The real case this guards: qwen3-coder-next is 48 GB and says so
    // nowhere in its name. A guess here would have been badly wrong.
    expect(estimateFootprint('qwen3-coder-next')).toBeNull()
  })
})

describe('fetchFootprint', () => {
  it('measures the first reference that resolves', async () => {
    const fp = await fetchFootprint(
      'llama3-8b',
      ['llama3:8b', 'llama3-8b'],
      registry({ 'llama3:8b': [4e9, 3e8] })
    )
    expect(fp.source).toBe('registry')
    expect(fp.weightsBytes).toBe(4.3e9)
  })

  it('walks past a reference nothing publishes', async () => {
    const fp = await fetchFootprint(
      'qwen3-coder-next',
      ['qwen3-coder-next', 'qwen3-coder:next'],
      registry({ 'qwen3-coder-next:latest': [48e9] })
    )
    expect(fp.source).toBe('registry')
    expect(fp.weightsBytes).toBe(48e9)
  })

  it('falls back to the estimate, then to unknown', async () => {
    const none = registry({})
    expect((await fetchFootprint('gpt-oss:20b', ['gpt-oss:20b'], none)).source).toBe('estimate')
    expect((await fetchFootprint('qwen3-coder-next', ['qwen3-coder-next'], none)).source).toBe(
      'unknown'
    )
  })

  it('treats a throwing fetch as offline rather than failing the caller', async () => {
    const boom = async () => {
      throw new Error('offline')
    }
    await expect(fetchFootprint('llama3-8b', ['llama3:8b'], boom)).resolves.toMatchObject({
      source: 'estimate'
    })
  })
})

describe('requirementsForModels', () => {
  const big = {
    name: 'big',
    weightsBytes: 60 * GIB,
    minVramBytes: 74 * GIB,
    diskBytes: 60 * GIB,
    source: 'registry' as const
  }
  const small = {
    name: 'small',
    weightsBytes: 4 * GIB,
    minVramBytes: 6 * GIB,
    diskBytes: 4 * GIB,
    source: 'registry' as const
  }

  it('takes VRAM from the largest and disk from the sum', () => {
    const req = requirementsForModels(DEFAULT_REQUIREMENTS, [big, small])
    expect(req.minVramBytes).toBe(74 * GIB)
    expect(req.minFreeDiskBytes).toBe(64 * GIB + 10 * GIB)
    expect(req.requiredModels).toEqual(['big', 'small'])
  })

  it('never drops below the package floor', () => {
    const req = requirementsForModels(DEFAULT_REQUIREMENTS, [small])
    expect(req.minVramBytes).toBe(DEFAULT_REQUIREMENTS.minVramBytes)
    expect(req.minFreeDiskBytes).toBe(DEFAULT_REQUIREMENTS.minFreeDiskBytes)
  })

  it('leaves the floor in place when nothing could be measured', () => {
    const unknown = {
      name: 'x',
      weightsBytes: 0,
      minVramBytes: 0,
      diskBytes: 0,
      source: 'unknown' as const
    }
    const req = requirementsForModels(DEFAULT_REQUIREMENTS, [unknown])
    expect(req.minVramBytes).toBe(DEFAULT_REQUIREMENTS.minVramBytes)
    expect(req.requiredModels).toEqual(['x'])
  })
})

describe('fits', () => {
  const big = {
    name: 'big',
    weightsBytes: 60 * GIB,
    minVramBytes: 74 * GIB,
    diskBytes: 60 * GIB,
    source: 'registry' as const
  }

  it('refuses a model larger than the memory available', () => {
    expect(fits(big, { availableVramBytes: 16 * GIB }).ok).toBe(false)
  })

  it('refuses a model larger than free disk', () => {
    expect(fits(big, { availableVramBytes: 128 * GIB, freeDiskBytes: 20 * GIB }).ok).toBe(false)
  })

  it('passes on a host with room', () => {
    expect(fits(big, { availableVramBytes: 128 * GIB, freeDiskBytes: 500 * GIB }).ok).toBe(true)
  })

  it('does not block a model whose size could not be read', () => {
    const unknown = {
      name: 'x',
      weightsBytes: 0,
      minVramBytes: 0,
      diskBytes: 0,
      source: 'unknown' as const
    }
    expect(fits(unknown, { availableVramBytes: 1 }).ok).toBe(true)
  })
})
