import { describe, expect, it } from 'vitest'
import { aliasModel, hasModel, modelCandidates, pullModel, startOllama } from './ollama.js'
import { parseOllamaVersion, plainText } from './parse.js'

/**
 * Every name here is one a live network actually whitelists — mainnet's single
 * model and the ten on devnet — rather than one chosen to suit the rule. That
 * is the point of the exercise: the convention has to survive the whitelist as
 * it is, and the whitelist is governance's to change without telling us.
 */
const DEVNET = [
  'gemma4-26b',
  'glm-4.7-flash',
  'qwen3-coder-30b',
  'qwen3.6-27b',
  'deepseek-r1-8b',
  'mistral-small-24b',
  'deepseek-r1-32b',
  'qwen2.5-coder-7b',
  'gpt-oss-20b',
  'llama3-8b'
]

describe('the registry references a network name might be published under', () => {
  it('splits at the parameter count first, which is the common convention', () => {
    expect(modelCandidates('llama3-8b')[0]).toBe('llama3:8b')
    expect(modelCandidates('deepseek-r1-32b')[0]).toBe('deepseek-r1:32b')
    expect(modelCandidates('qwen2.5-coder-7b')[0]).toBe('qwen2.5-coder:7b')
    expect(modelCandidates('mistral-small-24b')[0]).toBe('mistral-small:24b')
  })

  it('keeps the name itself as a fallback, since the convention is not a rule', () => {
    expect(modelCandidates('llama3-8b')).toEqual(['llama3:8b', 'llama3-8b'])
  })

  it('splits a variant suffix only after trying the whole name', () => {
    // `glm-4.7-flash` has no parameter count. Publishing it whole is the more
    // likely of the two, so `glm-4.7:flash` is the second guess and not the
    // first — the same shape as `deepseek-r1`, which is published whole and
    // would be ruined by splitting.
    expect(modelCandidates('glm-4.7-flash')).toEqual(['glm-4.7-flash', 'glm-4.7:flash'])
  })

  it('leaves a name with nothing to split alone', () => {
    expect(modelCandidates('mistral')).toEqual(['mistral'])
  })

  it('handles a fractional parameter count, since 1.5b models are named that way', () => {
    expect(modelCandidates('qwen2.5-1.5b')[0]).toBe('qwen2.5:1.5b')
  })

  it('leaves a reference that already carries a tag alone', () => {
    expect(modelCandidates('llama3:8b')).toEqual(['llama3:8b'])
  })

  it('offers at least one candidate for every model a live network whitelists', () => {
    for (const name of DEVNET) {
      const candidates = modelCandidates(name)
      expect(candidates.length).toBeGreaterThan(0)
      // The name itself is always reachable, so no whitelisted model is ever
      // unfetchable just because the convention did not fit it.
      expect(candidates).toContain(name)
    }
  })
})

describe('fetching a model', () => {
  it('pulls a reference and then names it as the network knows it', () => {
    expect(pullModel('llama3:8b').display).toBe('ollama pull llama3:8b')
    expect(aliasModel('llama3:8b', 'llama3-8b')?.display).toBe('ollama cp llama3:8b llama3-8b')
  })

  it('needs no copy when the reference already is the name', () => {
    expect(aliasModel('mistral', 'mistral')).toBeNull()
  })

  it('is argv, never a shell string', () => {
    expect(pullModel('llama3:8b')).toMatchObject({ file: 'ollama', args: ['pull', 'llama3:8b'] })
    expect(aliasModel('a:b', 'a-b')).toMatchObject({ file: 'ollama', args: ['cp', 'a:b', 'a-b'] })
  })
})

describe('whether a model is already here', () => {
  it('accepts the name, and the :latest Ollama appends to an untagged copy', () => {
    expect(hasModel(['llama3-8b'], 'llama3-8b')).toBe(true)
    expect(hasModel(['llama3-8b:latest'], 'llama3-8b')).toBe(true)
  })

  it('does not accept the reference it was pulled under', () => {
    // The whole failure this guards: `llama3:8b` is present, the worker looks
    // up `llama3-8b`, and nothing matches. It starts, takes work, resolves none.
    expect(hasModel(['llama3:8b'], 'llama3-8b')).toBe(false)
  })
})

describe('starting the runtime', () => {
  it('hands the job to the platform, and never to a command that does not exit', () => {
    // `ollama serve` would be owned by this process and die with the window,
    // which is the one thing a worker's runtime must not do.
    expect(startOllama('darwin')).toMatchObject({ file: 'open', args: ['-a', 'Ollama'] })
    expect(startOllama('linux')?.args).toEqual(['--user', 'start', 'ollama'])
    for (const platform of ['darwin', 'linux']) {
      expect(startOllama(platform)?.display).not.toContain('serve')
    }
  })

  it('answers null where there is no handle, rather than a button that lies', () => {
    expect(startOllama('win32')).toBeNull()
  })
})

describe('reading the runtime version', () => {
  it('finds it in either phrasing', () => {
    expect(parseOllamaVersion('ollama version is 0.5.7')).toBe('0.5.7')
    expect(parseOllamaVersion('ollama version 0.5.7')).toBe('0.5.7')
  })

  it('finds it even in the output of a client that could not reach a server', () => {
    // This exact case is why presence is not judged by exit status: the command
    // answers and fails at the same time.
    const output = [
      'Warning: could not connect to a running Ollama instance',
      'Warning: client version is 0.5.7'
    ].join('\n')
    expect(parseOllamaVersion(output)).toBe('0.5.7')
  })

  it('is undefined for a missing binary, which says nothing about a version', () => {
    expect(parseOllamaVersion('spawn ollama ENOENT')).toBeUndefined()
    expect(parseOllamaVersion(null)).toBeUndefined()
  })
})

describe('progress output in a pane that is not a terminal', () => {
  it('keeps what each rewritten line settled on', () => {
    expect(plainText('pulling 12%\rpulling 47%\rpulling 100%\n')).toBe('pulling 100%\n')
  })

  it('drops the escapes that would otherwise render as literal noise', () => {
    expect(plainText('\u001B[?25l\u001B[32mdone\u001B[0m\n')).toBe('done\n')
  })

  it('leaves ordinary output exactly as it was', () => {
    expect(plainText('success\nwriting manifest\n')).toBe('success\nwriting manifest\n')
  })
})
