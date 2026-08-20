import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { toMsixVersion } = require('../forge.config.js')

/**
 * The version written into the MSIX manifest before `make`.
 *
 * MSIX takes exactly four numeric parts, each 0–65535, and a prerelease tag
 * like `0.9.0-beta.1` is not one of those — the old mapper passed it through
 * and the maker rejected the manifest. The fold has to be deterministic, and
 * it has to keep a release installable over its own betas, or the tagged
 * build fails as a downgrade on every machine that ran one.
 */
describe('the MSIX version a tag becomes', () => {
  it('gives a plain release the top of the fourth part', () => {
    expect(toMsixVersion('0.1.0')).toBe('0.1.0.65535')
    expect(toMsixVersion('1.2.3')).toBe('1.2.3.65535')
  })

  it('carries a prerelease number into the fourth part', () => {
    expect(toMsixVersion('0.9.0-beta.1')).toBe('0.9.0.1')
    expect(toMsixVersion('0.9.0-beta.2')).toBe('0.9.0.2')
    expect(toMsixVersion('0.9.0-rc.12')).toBe('0.9.0.12')
  })

  it('maps a bare prerelease tag to zero', () => {
    expect(toMsixVersion('0.9.0-beta')).toBe('0.9.0.0')
  })

  it('ignores build metadata, as semver does', () => {
    expect(toMsixVersion('0.9.0+build.7')).toBe('0.9.0.65535')
    expect(toMsixVersion('0.9.0-beta.1+build.7')).toBe('0.9.0.1')
  })

  it('keeps a release installable over its own betas', () => {
    const numeric = (v) => v.split('.').map(Number)
    const beta = numeric(toMsixVersion('0.9.0-beta.2'))
    const release = numeric(toMsixVersion('0.9.0'))
    for (let i = 0; i < 4; i++) {
      if (release[i] === beta[i]) continue
      expect(release[i]).toBeGreaterThan(beta[i])
      break
    }
  })

  it('clamps a prerelease number past the range rather than emitting one', () => {
    expect(toMsixVersion('0.9.0-beta.70000')).toBe('0.9.0.65534')
  })

  it('is deterministic', () => {
    expect(toMsixVersion('0.9.0-beta.1')).toBe(toMsixVersion('0.9.0-beta.1'))
  })

  it('refuses what is not a semver version', () => {
    expect(() => toMsixVersion('beta')).toThrow(/MSIX/)
    expect(() => toMsixVersion('0.9')).toThrow(/MSIX/)
    expect(() => toMsixVersion('')).toThrow(/MSIX/)
  })

  it('refuses a part MSIX cannot hold', () => {
    expect(() => toMsixVersion('65536.0.0')).toThrow(/0-65535/)
  })
})
