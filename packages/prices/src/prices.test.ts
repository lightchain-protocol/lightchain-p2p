import { describe, expect, it } from 'vitest'
import {
  FEEDS,
  PRICE_DECIMALS,
  chainlinkPrices,
  decodeInt256,
  decodeRoundData,
  decodeSlot0,
  doubtAbout,
  formatUsd,
  priceFromSqrtX96,
  throughPair,
  toPrice
} from './index.js'

/**
 * The ways a price goes wrong without looking wrong.
 *
 * A misread price is not like a misread balance: nobody can tell by looking.
 * The failures worth guarding are the quiet ones — a negative answer read as an
 * enormous positive, a feed that has not written in a day shown as current, a
 * six-decimal token divided by eighteen. Each of those produces a plausible
 * number, which is what makes them worth their own tests.
 */

const HOUR = 60 * 60 * 1000
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const signedWord = (value: bigint) => word((value < 0n ? (1n << 256n) + value : value).toString(16))

const round = ({ answer = 0n, updatedAt = 0n } = {}) =>
  `0x${word('1')}${signedWord(answer)}${word('0')}${word(updatedAt.toString(16))}${word('1')}`

describe('the sign on an answer', () => {
  it('reads a positive one', () => {
    expect(decodeInt256(new Uint8Array(32).fill(0).map((_, i) => (i === 31 ? 5 : 0)))).toBe(5n)
  })

  it('reads a negative one as negative', () => {
    // Unsigned, this word is about 1.15e77. Arithmetic would carry it happily.
    const minusOne = new Uint8Array(32).fill(0xff)
    expect(decodeInt256(minusOne)).toBe(-1n)
  })

  it('reads the extremes', () => {
    const max = new Uint8Array(32).fill(0xff)
    max[0] = 0x7f
    expect(decodeInt256(max)).toBe(2n ** 255n - 1n)

    const min = new Uint8Array(32)
    min[0] = 0x80
    expect(decodeInt256(min)).toBe(-(2n ** 255n))
  })
})

describe('deciding whether to believe a feed', () => {
  const now = 1_700_000_000_000
  const written = (msAgo: number) => ({
    roundId: 1n,
    answer: 100n,
    startedAt: 0n,
    updatedAt: BigInt(Math.floor((now - msAgo) / 1000)),
    answeredInRound: 1n
  })

  it('believes a recent positive answer', () => {
    expect(doubtAbout(written(HOUR), 3 * HOUR, now)).toBe(null)
  })

  it('refuses zero and anything below it', () => {
    for (const answer of [0n, -1n, -500n]) {
      expect(doubtAbout({ ...written(0), answer }, 3 * HOUR, now)).toBe('not-positive')
    }
  })

  it('calls an answer past its own threshold stale', () => {
    expect(doubtAbout(written(4 * HOUR), 3 * HOUR, now)).toBe('stale')
  })

  it('does not call a quiet stablecoin stale', () => {
    // A feed writes only when the price moves past its deviation threshold, so
    // eighteen hours between updates is a stablecoin working, not one broken. A
    // flat one-hour rule would blank USDT, USDC, BNB and ARB together.
    expect(doubtAbout(written(18 * HOUR), 26 * HOUR, now)).toBe(null)
  })

  it('notices a feed that has never written at all', () => {
    expect(doubtAbout({ ...written(0), updatedAt: 0n }, 3 * HOUR, now)).toBe('never-updated')
  })
})

describe('scaling an answer', () => {
  it('handles the eight decimals every USD feed uses', () => {
    // $1936.05 as Chainlink reports it.
    expect(toPrice(193_605_000_000n, 8)).toBe(19_360_500n)
    expect(formatUsd(toPrice(193_605_000_000n, 8))).toBe('$1,936.05')
  })

  it('handles a feed that uses eighteen instead', () => {
    // Non-USD pairs commonly do. Assuming eight would misprice by ten orders
    // of magnitude, and the result would still look like a number.
    expect(toPrice(1n * 10n ** 18n, 18)).toBe(10n ** BigInt(PRICE_DECIMALS))
  })

  it('keeps how far a stablecoin has drifted from a dollar', () => {
    expect(formatUsd(toPrice(99_919_040n, 8))).toBe('$0.99')
  })
})

describe('showing a price', () => {
  it('groups thousands', () => {
    expect(formatUsd(648_000_000n)).toBe('$64,800.00')
  })

  it('keeps the digits that matter for a sub-cent price', () => {
    // LCAI trades near a tenth of a cent. Rounding to cents would show every
    // holding as worth nothing at all.
    expect(formatUsd(11n)).toBe('$0.0011')
  })

  it('says nothing rather than zero when there is no price', () => {
    expect(formatUsd(null)).toBe('-')
  })

  it('shows an exact zero as a price, not as an absence', () => {
    // And at two places rather than four. An empty wallet is the first thing a
    // new user sees, and `$0.0000` there reads as a precision artefact.
    expect(formatUsd(0n)).toBe('$0.00')
  })
})

describe('a Uniswap pool', () => {
  // The live LCAI/WETH pool, read on 19 August 2026.
  const LIVE = 60_909_433_415_399_060_051_834_632n

  it('reproduces the price the aggregators publish', () => {
    // CoinGecko said $0.00114554 for the same pool at the same time. Squaring
    // in a float loses this outright; the maths is bigint throughout.
    const perWeth = priceFromSqrtX96(LIVE)
    const usd = throughPair(perWeth, toPrice(193_605_000_000n, 8))

    // Within a tenth of a cent of $0.001144, which is as close as four decimal
    // places can express.
    expect(formatUsd(usd)).toBe('$0.0011')
  })

  it('corrects for two tokens with different decimals', () => {
    // A pool against USDC is six against eighteen. Getting it wrong is a factor
    // of a million million, in a number nobody can eyeball.
    const same = priceFromSqrtX96(LIVE, 18, 18)
    const mismatched = priceFromSqrtX96(LIVE, 18, 6)

    // Bounded rather than equal, because `same` is floored before this
    // multiplies it while `mismatched` keeps twelve more digits before its own
    // rounding. The relationship is exact; the comparison cannot be.
    expect(mismatched).toBeGreaterThanOrEqual(same * 10n ** 12n)
    expect(mismatched).toBeLessThan((same + 1n) * 10n ** 12n)
  })

  it('refuses a pool reporting no price', () => {
    expect(() => priceFromSqrtX96(0n)).toThrow(/price of zero/)
  })

  it('reads the observation buffer, which says whether a TWAP exists', () => {
    const data =
      '0x' +
      word(LIVE.toString(16)) +
      signedWord(-5n) +
      word('0') +
      word('1') +
      word('1') +
      word('0') +
      word('1')

    const slot0 = decodeSlot0(data)
    expect(slot0.sqrtPriceX96).toBe(LIVE)
    expect(slot0.tick).toBe(-5)
    // One observation means `observe` reverts for any useful window, so there
    // is no manipulation-resistant price available from this pool today.
    expect(slot0.observationCardinality).toBe(1)
  })

  it('refuses a truncated slot0', () => {
    expect(() => decodeSlot0('0x1234')).toThrow(/slot0 returned/)
  })
})

describe('reading a round', () => {
  it('pulls the answer and its timestamp out', () => {
    const data = round({ answer: 193_605_000_000n, updatedAt: 1_700_000_000n })
    expect(decodeRoundData(data).answer).toBe(193_605_000_000n)
    expect(decodeRoundData(data).updatedAt).toBe(1_700_000_000n)
  })

  it('refuses a short answer rather than reading past it', () => {
    expect(() => decodeRoundData('0x1234')).toThrow(/expected 160/)
  })
})

describe('the whole set of prices', () => {
  const now = 1_700_000_000_000
  const fresh = BigInt(Math.floor(now / 1000) - 600)

  /** A fake chain that answers every call in a fixed order. */
  function rpcReturning(answers: string[]) {
    let at = 0
    return {
      call: async () => answers[at++] ?? '0x'
    }
  }

  /** One feed's pair of answers: the round, then its decimals. */
  const feedAnswers = (answer: bigint, updatedAt = fresh) => [
    round({ answer, updatedAt }),
    `0x${word('8')}`
  ]

  const poolAnswer =
    '0x' +
    word(60_909_433_415_399_060_051_834_632n.toString(16)) +
    word('0') +
    word('0') +
    word('1') +
    word('1') +
    word('0') +
    word('1')

  it('prices every feed and LCAI beside them', async () => {
    const answers = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    const prices = await chainlinkPrices(rpcReturning(answers), null).all(now)

    for (const feed of FEEDS) {
      expect(prices.get(feed.symbol)?.usd, feed.symbol).toBe(10_000n)
      expect(prices.get(feed.symbol)?.doubt, feed.symbol).toBe(null)
    }

    expect(prices.get('LCAI')?.usd).not.toBe(null)
  })

  it('marks LCAI as indicative and the feeds as not', async () => {
    const answers = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    const prices = await chainlinkPrices(rpcReturning(answers), null).all(now)

    expect(prices.get('LCAI')?.indicative).toBe(true)
    expect(prices.get('ETH')?.indicative).toBe(false)
  })

  it('lets one bad feed cost only its own row', async () => {
    const answers = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    // Break the first feed's round data.
    answers[0] = '0xdeadbeef'

    const prices = await chainlinkPrices(rpcReturning(answers), null).all(now)
    expect(prices.get(FEEDS[0]!.symbol)?.usd).toBe(null)
    expect(prices.get(FEEDS[1]!.symbol)?.usd).toBe(10_000n)
  })

  it('drops the value of a negative answer but keeps a stale one', async () => {
    const negative = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    negative[0] = round({ answer: -1n, updatedAt: fresh })
    const a = await chainlinkPrices(rpcReturning(negative), null).all(now)
    expect(a.get(FEEDS[0]!.symbol)).toMatchObject({ usd: null, doubt: 'not-positive' })

    const old = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    old[0] = round({ answer: 100_000_000n, updatedAt: BigInt(Math.floor(now / 1000) - 90_000) })
    const b = await chainlinkPrices(rpcReturning(old), null).all(now)

    // Kept, because a greyed-out figure from yesterday says more than a blank.
    expect(b.get(FEEDS[0]!.symbol)?.usd).toBe(10_000n)
    expect(b.get(FEEDS[0]!.symbol)?.doubt).toBe('stale')
  })

  it('will not price LCAI when it cannot price ETH', async () => {
    // Without a dollar value for WETH, the pool gives a ratio rather than a
    // price. Inventing one would be the worst available option.
    const answers = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    const ethAt = FEEDS.findIndex((f) => f.symbol === 'ETH')
    answers[ethAt * 2] = round({ answer: 0n, updatedAt: fresh })

    const prices = await chainlinkPrices(rpcReturning(answers), null).all(now)
    expect(prices.get('LCAI')?.usd).toBe(null)
  })

  it('passes ETH staleness on to LCAI rather than hiding it', async () => {
    const answers = [...FEEDS.flatMap(() => feedAnswers(100_000_000n)), poolAnswer]
    const ethAt = FEEDS.findIndex((f) => f.symbol === 'ETH')
    answers[ethAt * 2] = round({
      answer: 100_000_000n,
      updatedAt: BigInt(Math.floor(now / 1000) - 90_000)
    })

    const prices = await chainlinkPrices(rpcReturning(answers), null).all(now)
    // A fresh pool read multiplied by yesterday's ETH price is yesterday's.
    expect(prices.get('LCAI')?.doubt).toBe('stale')
  })
})

describe('the feed table', () => {
  it('gives every feed a real address and a threshold', () => {
    for (const feed of FEEDS) {
      expect(feed.address, feed.symbol).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(feed.maxAgeMs, feed.symbol).toBeGreaterThan(HOUR)
    }
  })

  it('holds no duplicates', () => {
    expect(new Set(FEEDS.map((f) => f.symbol)).size).toBe(FEEDS.length)
    expect(new Set(FEEDS.map((f) => f.address.toLowerCase())).size).toBe(FEEDS.length)
  })

  it('gives stablecoins longer than volatile assets', () => {
    const eth = FEEDS.find((f) => f.symbol === 'ETH')!
    for (const symbol of ['USDC', 'USDT', 'DAI']) {
      expect(FEEDS.find((f) => f.symbol === symbol)!.maxAgeMs).toBeGreaterThan(eth.maxAgeMs)
    }
  })
})
