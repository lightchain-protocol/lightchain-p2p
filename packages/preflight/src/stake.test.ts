import { describe, expect, it } from 'vitest'
import { runChecks } from './index.js'

/**
 * The requirement that is neither hardware nor software, and the one the
 * tooling never mentions: registering stakes the minimum as the transaction's
 * value, so an underfunded address fails at the transaction with an error that
 * does not say how much was needed. Every other check can pass while this one
 * cannot.
 */

const MIN = 50_000n * 10n ** 18n
const ADDRESS = '0xD1407800Df28ef544Fd0a9cE5f2680Df10917aBe'

const stakeCheck = (stake: Parameters<typeof runChecks>[0]['stake']) =>
  runChecks({ stake }).find((c) => c.id === 'stake')

describe('the stake check', () => {
  it('says nothing before there is a keystore', () => {
    // No address means nothing to fund yet, and a second message about a
    // missing keystore helps nobody.
    expect(stakeCheck(undefined)).toBeUndefined()
    expect(stakeCheck({})).toBeUndefined()
  })

  it('passes when the balance covers the stake and some gas', () => {
    const check = stakeCheck({ address: ADDRESS, minimum: MIN, balance: MIN + 5n * 10n ** 18n })
    expect(check?.status).toBe('pass')
    expect(check?.detail).toContain('50005')
    expect(check?.detail).toContain('will stake 50000')
  })

  it('fails when the balance is short, and says by how much', () => {
    const check = stakeCheck({ address: ADDRESS, minimum: MIN, balance: 49_000n * 10n ** 18n })
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('49000')
    // Short by 1000, plus one for gas.
    expect(check?.remedy).toContain('1001')
  })

  it('fails on exactly the minimum, because gas comes out of the same balance', () => {
    // The trap: LCAI is the native token, so a wallet holding precisely the
    // stake cannot pay to post it.
    const check = stakeCheck({ address: ADDRESS, minimum: MIN, balance: MIN })
    expect(check?.status).toBe('fail')
    expect(check?.remedy).toContain('gas comes out of the same balance')
  })

  it('names the unit after every amount', () => {
    // An amount with no unit beside it is how somebody sends 50000 wei.
    for (const balance of [MIN + 10n ** 19n, 1n]) {
      const check = stakeCheck({ address: ADDRESS, minimum: MIN, balance })
      const text = `${check?.detail} ${check?.remedy ?? ''}`

      for (const amount of text.matchAll(/\b\d[\d.]*\b/g)) {
        // Allowing a word between, for "50000.9999 more LCAI".
        const following = text.slice(
          (amount.index ?? 0) + amount[0].length,
          (amount.index ?? 0) + amount[0].length + 12
        )
        expect(following.includes('LCAI'), `"${amount[0]}" has no unit: "…${following}"`).toBe(true)
      }
    }
  })

  it('is satisfied once the worker is registered', () => {
    const check = stakeCheck({ address: ADDRESS, registered: true })
    expect(check?.status).toBe('pass')
    expect(check?.detail).toContain('stake is posted')
  })

  it('warns rather than failing when the chain cannot be read', () => {
    // Not knowing is not the same as being short, and blocking a host because
    // an RPC was briefly down would be wrong.
    const check = stakeCheck({ address: ADDRESS, unreachable: true })
    expect(check?.status).toBe('warn')
    expect(check?.remedy).toContain('RPC is reachable')
  })

  it('does not report a minimum it never read', () => {
    expect(stakeCheck({ address: ADDRESS, balance: 1n })?.status).toBe('warn')
    expect(stakeCheck({ address: ADDRESS, minimum: MIN })?.status).toBe('warn')
  })

  it('reads amounts as people write them', () => {
    const check = stakeCheck({
      address: ADDRESS,
      minimum: 5_000n * 10n ** 18n,
      balance: 5_000n * 10n ** 18n + 10n ** 17n
    })
    // 5000.1, not 5000.100000000000000000 and not 5.0001e21.
    expect(check?.detail).toContain('5000.1')
  })
})
