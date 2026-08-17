import { describe, expect, it } from 'vitest'
import {
  MANIFEST_VERSION,
  ManifestError,
  ModelRefError,
  encodeManifest,
  formatModelRef,
  modelRefEquals,
  parseManifest,
  parseModelRef,
  type ModelManifest
} from './index.js'

const KEY = 'a'.repeat(64)

describe('model references', () => {
  it('round-trips the canonical form', () => {
    expect(parseModelRef(formatModelRef({ key: KEY, version: 7 }))).toEqual({
      key: KEY,
      version: 7
    })
  })

  it('refuses a bare key', () => {
    // The whole point of the type: a key alone names a mutable history, so
    // accepting one would let a publisher change a model after it was priced.
    expect(() => parseModelRef(KEY)).toThrow(/does not identify content/)
  })

  it('rejects version forms that Number() would silently accept', () => {
    for (const bad of [`${KEY}@1e3`, `${KEY}@ 12`, `${KEY}@12.0`, `${KEY}@0x10`, `${KEY}@`]) {
      expect(() => parseModelRef(bad), bad).toThrow(ModelRefError)
    }
  })

  it('rejects version zero, because Hyperbee never reports it for real content', () => {
    expect(() => parseModelRef(`${KEY}@0`)).toThrow(/at least 1/)
  })

  it('rejects malformed keys', () => {
    for (const bad of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() => parseModelRef(`${bad}@1`), bad).toThrow(ModelRefError)
    }
  })

  it('compares by content, not identity', () => {
    expect(modelRefEquals({ key: KEY, version: 1 }, { key: KEY, version: 1 })).toBe(true)
    expect(modelRefEquals({ key: KEY, version: 1 }, { key: KEY, version: 2 })).toBe(false)
  })
})

describe('manifest', () => {
  const valid: ModelManifest = {
    manifestVersion: MANIFEST_VERSION,
    name: 'test-model',
    files: [
      { path: '/model.gguf', bytes: 1024, role: 'weights' },
      { path: '/tokenizer.json', bytes: 64, role: 'tokenizer' }
    ]
  }

  it('round-trips', () => {
    expect(parseManifest(encodeManifest(valid))).toMatchObject({
      name: 'test-model',
      files: valid.files
    })
  })

  it('accepts a Uint8Array as well as a string', () => {
    const bytes = new TextEncoder().encode(encodeManifest(valid))
    expect(parseManifest(bytes).name).toBe('test-model')
  })

  it('ignores unknown fields so a new publisher does not break an old reader', () => {
    // This is the forward-compatibility guarantee. If this test starts failing,
    // every already-shipped client breaks the next time a field is added.
    const withFuture = JSON.parse(encodeManifest(valid))
    withFuture.somethingAddedIn2027 = { nested: true }
    withFuture.files[0].futureRoleHint = 'adapter'

    const parsed = parseManifest(JSON.stringify(withFuture))
    expect(parsed.name).toBe('test-model')
    expect(parsed.files[0]).toEqual({ path: '/model.gguf', bytes: 1024, role: 'weights' })
  })

  it('accepts an unrecognised role', () => {
    const m = { ...valid, files: [{ path: '/a.bin', bytes: 1, role: 'something-new' }] }
    expect(parseManifest(encodeManifest(m as ModelManifest)).files[0]?.role).toBe('something-new')
  })

  it('refuses a manifest from the future', () => {
    const ahead = { ...JSON.parse(encodeManifest(valid)), manifestVersion: MANIFEST_VERSION + 1 }
    expect(() => parseManifest(JSON.stringify(ahead))).toThrow(/newer than this build/)
  })

  it('requires paths to be absolute within the drive', () => {
    const m = JSON.parse(encodeManifest(valid))
    m.files[0].path = 'model.gguf'
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/must be absolute/)
  })

  it('rejects duplicate paths', () => {
    const m = JSON.parse(encodeManifest(valid))
    m.files[1].path = m.files[0].path
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/duplicate file path/)
  })

  it('rejects negative or fractional byte counts', () => {
    for (const bytes of [-1, 1.5, Number.NaN]) {
      const m = JSON.parse(encodeManifest(valid))
      m.files[0].bytes = bytes
      expect(() => parseManifest(JSON.stringify(m)), String(bytes)).toThrow(/non-negative integer/)
    }
  })

  it('reports malformed JSON as a manifest problem', () => {
    expect(() => parseManifest('{ not json')).toThrow(ManifestError)
  })

  it('rejects non-objects', () => {
    for (const bad of ['[]', '"string"', 'null', '42']) {
      expect(() => parseManifest(bad), bad).toThrow(ManifestError)
    }
  })

  it('omits absent optional fields rather than writing nulls', () => {
    const encoded = encodeManifest(valid)
    expect(encoded).not.toContain('null')
    expect(encoded).not.toContain('description')
  })
})
