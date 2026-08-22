import { describe, expect, it } from 'vitest'
import { truncate } from '../renderer/lib/amounts.js'

/**
 * Shortening a long value, which three modules were doing three ways.
 */
describe('truncate', () => {
  it('takes the middle out of something long', () => {
    const key = `0x${'ab'.repeat(48)}`
    expect(truncate(key, 14, 8)).toBe(`${key.slice(0, 14)}…${key.slice(-8)}`)
  })

  it('leaves anything already short enough alone', () => {
    // An ellipsis that saves no space only removes information.
    expect(truncate('0xabc', 10, 6)).toBe('0xabc')
  })

  it('shortens an address and a validator key differently', () => {
    // 42 characters and 98: six-and-four on the latter hides the part somebody
    // is actually checking.
    expect(truncate(`0x${'a'.repeat(40)}`, 6, 4)).toHaveLength(11)
    expect(truncate(`0x${'b'.repeat(96)}`, 14, 8)).toHaveLength(23)
  })

  it('at six-and-four is what dom.js\u2019s short() is built on', () => {
    const address = `0x${'a'.repeat(40)}`
    expect(truncate(address, 6, 4)).toBe(`${address.slice(0, 6)}\u2026${address.slice(-4)}`)
  })
})
