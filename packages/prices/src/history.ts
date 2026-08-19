import { encodeCall } from '@lcai-p2p/chain'
import { PRICE_DECIMALS, decodeRoundData, toPrice, type RoundData } from './chainlink.js'

/**
 * Past prices, from the same aggregators the current one comes from.
 *
 * A Chainlink feed keeps every round it has ever written, and `getRoundData`
 * will hand back any of them. So a chart needs no price API, no key and no
 * third party — which matters here for the same reason the current price does:
 * every hosted provider licenses its data for personal use, and asking one
 * would tell it exactly which assets somebody holds.
 *
 * ## Rounds are not evenly spaced
 *
 * A feed writes when the price moves past its deviation threshold, or when its
 * heartbeat expires — whichever comes first. So a volatile day produces many
 * rounds and a quiet week produces few, and there is no round-per-hour to
 * divide by. Everything below therefore samples generously and filters by the
 * timestamp that comes back, rather than trusting an arithmetic guess about
 * how far back a given number of rounds reaches.
 *
 * ## A round id is two numbers
 *
 * The high 64 bits are the phase, which changes when the aggregator behind the
 * proxy is replaced; the low 64 are the round within that phase. Walking back
 * means decrementing the low half, and walking off the start of a phase means
 * the call reverts rather than returning older data. Those reverts are expected
 * and are dropped — which is why every read goes through `aggregate3`, whose
 * whole point is that one failed call does not take the batch with it.
 */

/** How far back each range looks, and how coarsely it samples to get there. */
export interface Range {
  readonly windowMs: number
  /** Rounds skipped between samples. Larger reaches further for the same cost. */
  readonly stride: number
  /** How many samples to ask for. One batched call, whatever this is. */
  readonly count: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * The ranges a chart offers.
 *
 * The strides are calibrated against ETH/USD, which writes roughly forty-six
 * rounds a day. A quieter feed reaches further back with the same stride and a
 * busier one falls short; both are fine, because the window is applied to the
 * timestamps rather than assumed from the count.
 */
export const RANGES: Readonly<Record<string, Range>> = {
  '24h': { windowMs: DAY, stride: 1, count: 60 },
  '1w': { windowMs: 7 * DAY, stride: 6, count: 60 },
  '1m': { windowMs: 30 * DAY, stride: 26, count: 60 },
  '1y': { windowMs: 365 * DAY, stride: 300, count: 60 },
  all: { windowMs: 20 * 365 * DAY, stride: 1500, count: 60 }
}

/** What a sparkline needs: coarse, cheap, and the same shape as a chart. */
export const SPARKLINE: Range = { windowMs: 7 * DAY, stride: 14, count: 26 }

/**
 * A stride that actually reaches back as far as the window wants.
 *
 * Feeds write at wildly different rates: ETH/USD manages around forty-six
 * rounds a day, while USDT/USD can go eighteen hours without writing at all,
 * because it only writes when the price moves past its threshold. One fixed
 * stride cannot serve both — the value that gives ETH a week of history walks
 * USDT back six months, and every sample but the first falls outside the
 * window and is discarded. That is exactly what a missing sparkline looked
 * like.
 *
 * So the rate is measured rather than assumed: read one round a known distance
 * back, see how long ago it was, and divide. One extra call, once per cache
 * period, and every feed gets a line.
 */
export function strideFor(range: Range, roundsSampled: number, spanMs: number): number {
  // A feed that has not moved in the sampled span tells us nothing about its
  // rate. Falling back to one keeps every sample close together, which is the
  // safe direction: too little history rather than none.
  if (spanMs <= 0) return 1

  const perMs = roundsSampled / spanMs
  const wanted = Math.floor((range.windowMs * perMs) / range.count)

  return Math.max(1, wanted)
}

/**
 * The change over a window ending now, from a series that may reach further.
 *
 * A separate question from {@link Series.changeBps}, which spans whatever the
 * series covers. The list shows a day and the chart shows a week, and computing
 * both from one set of points beats fetching twice.
 */
export function changeOver(points: readonly Point[], windowMs: number, now: number): number | null {
  const inside = points.filter((p) => now - p.at <= windowMs)

  // The last point before the window is the right baseline when nothing was
  // written inside it — a price that has not moved all day has not moved, and
  // reporting nothing would be reporting an outage.
  const before = points.filter((p) => now - p.at > windowMs)
  const first = inside[0] ?? before[before.length - 1]
  const last = points[points.length - 1]

  if (!first || !last || first === last || first.usd === 0n) return null
  return Number(((last.usd - first.usd) * 10_000n) / first.usd)
}

export interface Point {
  /** Milliseconds. */
  readonly at: number
  /** Scaled by {@link PRICE_DECIMALS}. */
  readonly usd: bigint
}

export interface Series {
  readonly points: readonly Point[]
  /** Change across the series, in hundredths of a percent. Null with fewer than two points. */
  readonly changeBps: number | null
  readonly low: bigint | null
  readonly high: bigint | null
}

/** `getRoundData(uint80)`. */
export function roundDataCall(roundId: bigint): string {
  return encodeCall('getRoundData(uint80)', ['uint256'], [roundId])
}

/**
 * The round ids to ask for, walking back from the latest.
 *
 * Stops at the start of the phase rather than underflowing into the phase
 * below, whose rounds belong to a different aggregator and are not a
 * continuation of this series.
 */
export function roundsBackFrom(latest: bigint, range: Range): bigint[] {
  const phase = latest >> 64n
  const first = phase << 64n

  const ids: bigint[] = []
  for (let i = 0; i < range.count; i++) {
    const id = latest - BigInt(i * range.stride)
    if (id <= first) break
    ids.push(id)
  }

  return ids
}

/**
 * Turns whatever the batch returned into a series.
 *
 * Anything that failed, answered zero or fell outside the window is dropped
 * here rather than earlier, because which of those a given round is depends on
 * its timestamp — and the timestamp only arrives with the answer.
 */
export function seriesFrom(
  answers: readonly { success: boolean; data: string }[],
  feedDecimals: number,
  range: Range,
  now: number
): Series {
  const points: Point[] = []

  for (const answer of answers) {
    if (!answer.success) continue

    let round: RoundData
    try {
      round = decodeRoundData(answer.data)
    } catch {
      continue
    }

    if (round.answer <= 0n || round.updatedAt === 0n) continue

    const at = Number(round.updatedAt) * 1000
    if (now - at > range.windowMs) continue

    points.push({ at, usd: toPrice(round.answer, feedDecimals) })
  }

  // Oldest first, which is the order a chart draws in.
  points.sort((a, b) => a.at - b.at)

  const first = points[0]
  const last = points[points.length - 1]

  if (!first || !last || points.length < 2 || first.usd === 0n) {
    return { points, changeBps: null, low: null, high: null }
  }

  let low = points[0]!.usd
  let high = points[0]!.usd
  for (const point of points) {
    if (point.usd < low) low = point.usd
    if (point.usd > high) high = point.usd
  }

  // Basis points, as an integer. A percentage as a float here would be the one
  // number in this package carrying rounding error, and it is shown to two
  // decimal places anyway.
  const changeBps = Number(((last.usd - first.usd) * 10_000n) / first.usd)

  return { points, changeBps, low, high }
}

/** A change in basis points as something to read. */
export function formatChange(changeBps: number | null): string {
  if (changeBps === null) return '—'
  const sign = changeBps > 0 ? '+' : ''
  return `${sign}${(changeBps / 100).toFixed(2)}%`
}

/**
 * Evenly spaced moments across a window, ending now.
 *
 * Series cannot be added together as they come back. Feeds write when their own
 * price moves, so ETH's timestamps and USDC's have nothing to do with each
 * other, and summing them point by point would be adding a price from Tuesday
 * to one from Thursday and plotting the result. Everything is resampled onto
 * one grid first, and this is the grid.
 */
export function gridAcross(windowMs: number, points: number, now: number): number[] {
  const count = Math.max(2, points)
  const step = windowMs / (count - 1)

  return Array.from({ length: count }, (_, i) => Math.round(now - windowMs + i * step))
}

/**
 * A series resampled onto a grid, carrying each price forward.
 *
 * At every grid point, the value is the last price written **at or before** it.
 * Forward and not interpolated, because that is what was true: a feed that has
 * not written since Tuesday is a feed whose last word is Tuesday's, and drawing
 * a line sloping towards Thursday's price invents a movement nobody observed.
 *
 * Grid points before the series begins are null rather than zero. An asset the
 * feed has no answer for yet is not an asset worth nothing, and the difference
 * decides whether a portfolio total can honestly be drawn that far back.
 */
export function forwardFill(points: readonly Point[], grid: readonly number[]): (bigint | null)[] {
  if (points.length === 0) return grid.map(() => null)

  // Sorted rather than assumed sorted. `seriesFrom` orders its output, but this
  // is exported and the cost of being wrong is a line that jumps backwards.
  const ordered = [...points].sort((a, b) => a.at - b.at)

  const out: (bigint | null)[] = []
  let at = 0
  let held: bigint | null = null

  for (const moment of grid) {
    while (at < ordered.length && ordered[at]!.at <= moment) {
      held = ordered[at]!.usd
      at++
    }
    out.push(held)
  }

  return out
}

/** One asset's contribution to a portfolio: how much is held, and what it was worth. */
export interface Holding {
  readonly balance: bigint
  readonly decimals: number
  readonly points: readonly Point[]
}

export interface Portfolio {
  readonly points: readonly Point[]
  readonly changeBps: number | null
  /**
   * How many holdings had no price at any point on the grid.
   *
   * Reported rather than folded in silently. A total that quietly omits an
   * asset is a total somebody will compare against the holdings list and find
   * short, with nothing on screen explaining the difference.
   */
  readonly unpriced: number
}

/**
 * What a set of holdings was worth across a window, at today's balances.
 *
 * Not a record of the account's value over time — nothing here has ever
 * recorded what was held in the past. It is today's holdings priced backwards,
 * which is a different and still useful thing, and the interface says so.
 *
 * A grid point where **nothing** could be priced is dropped rather than plotted
 * as zero. Early points often fall before the feeds' sampled range, and a line
 * that starts at zero and leaps up reads as a portfolio that was empty and
 * suddenly was not.
 */
export function portfolioAcross(holdings: readonly Holding[], grid: readonly number[]): Portfolio {
  const filled = holdings.map((holding) => forwardFill(holding.points, grid))
  const unpriced = filled.filter((series) => series.every((v) => v === null)).length

  const points: Point[] = []

  grid.forEach((moment, i) => {
    let total = 0n
    let priced = false

    holdings.forEach((holding, h) => {
      // `undefined` as well as null: the grid and every filled series are the
      // same length by construction, and reading past the end would silently
      // contribute nothing rather than saying the two had drifted apart.
      const usd = filled[h]?.[i]
      if (usd === null || usd === undefined) return

      priced = true
      total += (holding.balance * usd) / 10n ** BigInt(holding.decimals)
    })

    if (priced) points.push({ at: moment, usd: total })
  })

  const first = points[0]
  const last = points[points.length - 1]

  const changeBps =
    first && last && first !== last && first.usd > 0n
      ? Number(((last.usd - first.usd) * 10_000n) / first.usd)
      : null

  return { points, changeBps, unpriced }
}

export { PRICE_DECIMALS }
