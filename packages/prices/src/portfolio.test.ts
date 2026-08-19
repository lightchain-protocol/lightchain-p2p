import { describe, expect, it } from 'vitest'
import { forwardFill, gridAcross, portfolioAcross, type Point } from './history.js'

/**
 * Adding up series that disagree about when they were sampled.
 *
 * This is the part of a portfolio chart that goes wrong invisibly. Feeds write
 * when their own price moves, so no two of them share timestamps, and a naive
 * sum adds Tuesday's ether to Thursday's dollar and plots a number that never
 * existed. Every failure mode here produces a smooth, plausible line.
 */

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

const at = (hoursAgo: number, usd: bigint): Point => ({ at: NOW - hoursAgo * HOUR, usd })

/** One dollar, at the four decimal places prices carry. */
const ONE = 10_000n

describe('the grid', () => {
  it('ends at now and starts a window back', () => {
    const grid = gridAcross(24 * HOUR, 5, NOW)
    expect(grid[0]).toBe(NOW - 24 * HOUR)
    expect(grid[grid.length - 1]).toBe(NOW)
  })

  it('is evenly spaced', () => {
    const grid = gridAcross(24 * HOUR, 5, NOW)
    const gaps = grid.slice(1).map((m, i) => m - grid[i]!)
    expect(new Set(gaps).size).toBe(1)
    expect(gaps[0]).toBe(6 * HOUR)
  })

  it('gives the number of points asked for', () => {
    expect(gridAcross(24 * HOUR, 60, NOW)).toHaveLength(60)
  })

  it('refuses to produce a grid too short to draw', () => {
    // One point is not a line, and a zero-length step would divide by zero.
    expect(gridAcross(24 * HOUR, 1, NOW)).toHaveLength(2)
    expect(gridAcross(24 * HOUR, 0, NOW)).toHaveLength(2)
  })
})

describe('carrying a price forward', () => {
  const grid = gridAcross(4 * HOUR, 5, NOW) // now-4h, -3h, -2h, -1h, now

  it('takes the last price written at or before each point', () => {
    const points = [at(4, 100n), at(2, 200n)]
    expect(forwardFill(points, grid)).toEqual([100n, 100n, 200n, 200n, 200n])
  })

  it('holds a price rather than sloping towards the next one', () => {
    // A feed that has not written since Tuesday has said nothing since
    // Tuesday. Interpolating invents a movement nobody observed.
    const points = [at(4, 100n), at(0, 200n)]
    expect(forwardFill(points, grid)).toEqual([100n, 100n, 100n, 100n, 200n])
  })

  it('reports null before the series begins, not zero', () => {
    // An asset the feed has no answer for yet is not an asset worth nothing,
    // and only one of those can honestly be added to a total.
    const points = [at(1, 500n)]
    expect(forwardFill(points, grid)).toEqual([null, null, null, 500n, 500n])
  })

  it('is all null when there is nothing at all', () => {
    expect(forwardFill([], grid)).toEqual([null, null, null, null, null])
  })

  it('takes the newest when several land before one point', () => {
    const points = [at(4, 100n), at(3.9, 150n), at(3.8, 175n)]
    expect(forwardFill(points, grid)[1]).toBe(175n)
  })

  it('sorts what it is given rather than trusting the order', () => {
    const jumbled = [at(2, 200n), at(4, 100n)]
    expect(forwardFill(jumbled, grid)).toEqual([100n, 100n, 200n, 200n, 200n])
  })

  it('includes a price written exactly on a grid point', () => {
    const points = [{ at: grid[2]!, usd: 300n }]
    expect(forwardFill(points, grid)).toEqual([null, null, 300n, 300n, 300n])
  })
})

describe('adding holdings up', () => {
  const grid = gridAcross(4 * HOUR, 5, NOW)

  it('sums two assets whose feeds never share a timestamp', () => {
    // The whole point. One writes on the hour, the other between them, and
    // neither series alone lines up with the grid.
    const portfolio = portfolioAcross(
      [
        { balance: 2n * 10n ** 18n, decimals: 18, points: [at(4, ONE * 100n), at(2, ONE * 200n)] },
        { balance: 3n * 10n ** 6n, decimals: 6, points: [at(3.5, ONE), at(1.5, ONE)] }
      ],
      grid
    )

    // At the start only ether is priced: two at a hundred.
    expect(portfolio.points[0]?.usd).toBe(ONE * 200n)
    // By the end both are: two at two hundred, plus three dollars.
    expect(portfolio.points[portfolio.points.length - 1]?.usd).toBe(ONE * 403n)
  })

  it('respects each asset\u2019s own decimals', () => {
    // Six against eighteen. Getting this wrong is a factor of a million
    // million, in a chart nobody can eyeball.
    const portfolio = portfolioAcross(
      [{ balance: 1_000_000n, decimals: 6, points: [at(4, ONE)] }],
      grid
    )
    expect(portfolio.points[0]?.usd).toBe(ONE)
  })

  it('drops grid points where nothing could be priced', () => {
    // Rather than plotting them as zero, which reads as a portfolio that was
    // empty and then suddenly was not.
    const portfolio = portfolioAcross(
      [{ balance: 10n ** 18n, decimals: 18, points: [at(1, ONE * 50n)] }],
      grid
    )
    expect(portfolio.points).toHaveLength(2)
    expect(portfolio.points[0]?.at).toBe(grid[3])
  })

  it('counts what it could not price', () => {
    const portfolio = portfolioAcross(
      [
        { balance: 10n ** 18n, decimals: 18, points: [at(4, ONE)] },
        { balance: 10n ** 18n, decimals: 18, points: [] },
        { balance: 5n * 10n ** 18n, decimals: 18, points: [] }
      ],
      grid
    )
    expect(portfolio.unpriced).toBe(2)
  })

  it('does not let an unpriced asset drag the total down', () => {
    const withGap = portfolioAcross(
      [
        { balance: 10n ** 18n, decimals: 18, points: [at(4, ONE * 10n)] },
        { balance: 99n * 10n ** 18n, decimals: 18, points: [] }
      ],
      grid
    )
    const alone = portfolioAcross(
      [{ balance: 10n ** 18n, decimals: 18, points: [at(4, ONE * 10n)] }],
      grid
    )
    expect(withGap.points.map((p) => p.usd)).toEqual(alone.points.map((p) => p.usd))
  })

  it('reports the change across the drawn points', () => {
    const portfolio = portfolioAcross(
      [{ balance: 10n ** 18n, decimals: 18, points: [at(4, ONE * 100n), at(1, ONE * 150n)] }],
      grid
    )
    // A hundred to a hundred and fifty is fifty percent, which is 5000 bps.
    expect(portfolio.changeBps).toBe(5000)
  })

  it('reports a fall as negative', () => {
    const portfolio = portfolioAcross(
      [{ balance: 10n ** 18n, decimals: 18, points: [at(4, ONE * 200n), at(1, ONE * 100n)] }],
      grid
    )
    expect(portfolio.changeBps).toBe(-5000)
  })

  it('has no change to report from a single point', () => {
    const portfolio = portfolioAcross(
      [{ balance: 10n ** 18n, decimals: 18, points: [{ at: NOW, usd: ONE }] }],
      grid
    )
    expect(portfolio.changeBps).toBe(null)
  })

  it('holds an empty portfolio without dividing by zero', () => {
    const portfolio = portfolioAcross([], grid)
    expect(portfolio.points).toEqual([])
    expect(portfolio.changeBps).toBe(null)
    expect(portfolio.unpriced).toBe(0)
  })

  it('holds a zero balance without calling it unpriced', () => {
    // A tracked asset held at zero is priced perfectly well; it simply
    // contributes nothing. Counting it as unpriced would make every wallet
    // report an incomplete total.
    const portfolio = portfolioAcross(
      [{ balance: 0n, decimals: 18, points: [at(4, ONE * 100n)] }],
      grid
    )
    expect(portfolio.unpriced).toBe(0)
    expect(portfolio.points[0]?.usd).toBe(0n)
  })

  it('survives a balance far past what a double could hold', () => {
    const huge = 10n ** 30n
    const portfolio = portfolioAcross([{ balance: huge, decimals: 18, points: [at(4, ONE)] }], grid)
    expect(portfolio.points[0]?.usd).toBe((huge * ONE) / 10n ** 18n)
  })
})
