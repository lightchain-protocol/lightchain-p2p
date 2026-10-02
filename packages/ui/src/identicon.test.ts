import { describe, expect, it } from 'vitest'
import {
  AA_NON_TEXT,
  BRAND,
  DARK,
  IDENTICON_INK,
  IDENTICON_SIZE,
  contrastRatio,
  identicon,
  identiconSvg,
  type Identicon,
  type Palette
} from './index.js'

const CHECKSUMMED = '0xD140b1E1b12E0dA7bC0e5c78d0F0Cd10A38c7aBe'

/**
 * A crowd of addresses.
 *
 * Two addresses that differ prove nothing. The failures worth catching — a hash
 * whose low bits barely move, an ink that is always the same one, a grid that
 * leans to one side — only appear across a crowd, so the sample is wide. It
 * comes out of a fixed sequence rather than a random one because a wide sample
 * that differs per run turns any failure into a story about somebody's machine.
 */
function sampleAddresses(count: number): string[] {
  // xorshift32, which is four lines and needs nothing from the host.
  let state = 0x2f6e2b1
  const nibble = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state & 15
  }

  const addresses: string[] = []
  for (let i = 0; i < count; i++) {
    let hex = ''
    for (let n = 0; n < 40; n++) hex += '0123456789abcdef'.charAt(nibble())
    addresses.push(`0x${hex}`)
  }
  return addresses
}

/** Every address that differs from `CHECKSUMMED` in exactly one character. */
function singleCharacterVariants(address: string): string[] {
  const variants: string[] = []
  for (let i = 2; i < address.length; i++) {
    for (const c of '0123456789abcdef') {
      if (address.charAt(i).toLowerCase() === c) continue
      variants.push(address.slice(0, i) + c + address.slice(i + 1))
    }
  }
  return variants
}

const SAMPLE = sampleAddresses(512)
const NEIGHBOURS = singleCharacterVariants(CHECKSUMMED)

/** The whole picture as one comparable string: ink plus pattern. */
function fingerprint(source: string): string {
  const image = identicon(source)
  return `${image.color} ${rows(image).join('/')}`
}

/** The grid as one string per row, which is far easier to read in a diff. */
function rows(image: Identicon): string[] {
  return image.cells.map((row) => row.map((on) => (on ? '#' : '.')).join(''))
}

function painted(image: Identicon): number {
  return image.cells.reduce((total, row) => total + row.filter(Boolean).length, 0)
}

const POSSIBLE_IMAGES = 2 ** (IDENTICON_SIZE * Math.ceil(IDENTICON_SIZE / 2)) * IDENTICON_INK.length

describe('identicon grids', () => {
  it('gives an address the same picture every time it is asked', () => {
    for (const address of SAMPLE.slice(0, 32)) {
      const first = identicon(address)
      expect(identicon(address)).toEqual(first)
      expect(identicon(address)).toEqual(first)
    }
  })

  // The pictures are how people recognise each other, so changing them is a
  // visible regression rather than an implementation detail. This pins the
  // algorithm: a refactor that quietly redraws everybody fails here first.
  it('draws the picture it has always drawn for a known address', () => {
    const image = identicon(CHECKSUMMED)
    expect(image.color).toBe('#dd00ac')
    expect(rows(image)).toEqual(['.....', '#.#.#', '.#.#.', '#.#.#', '#...#'])
  })

  it('treats a checksummed address and its lower-case form as one account', () => {
    for (const address of SAMPLE.slice(0, 64)) {
      const upper = `0x${address.slice(2).toUpperCase()}`
      expect(fingerprint(upper), address).toBe(fingerprint(address))
      expect(fingerprint(address.toUpperCase()), address).toBe(fingerprint(address))
    }
    expect(fingerprint(CHECKSUMMED)).toBe(fingerprint(CHECKSUMMED.toLowerCase()))
  })

  it('reads a bare hex key and its prefixed spelling as the same identity', () => {
    expect(fingerprint(CHECKSUMMED.slice(2))).toBe(fingerprint(CHECKSUMMED))
  })

  it('ignores whitespace around the source', () => {
    expect(fingerprint(`  ${CHECKSUMMED}\n`)).toBe(fingerprint(CHECKSUMMED))
  })

  it('refuses an empty source rather than drawing an avatar for nobody', () => {
    expect(() => identicon('')).toThrow(/empty string/)
    expect(() => identicon('   ')).toThrow(/empty string/)
  })

  it('is always the size it advertises', () => {
    for (const address of SAMPLE) {
      const image = identicon(address)
      expect(image.size).toBe(IDENTICON_SIZE)
      expect(image.cells).toHaveLength(IDENTICON_SIZE)
      for (const row of image.cells) expect(row).toHaveLength(IDENTICON_SIZE)
    }
  })

  it('mirrors every row down the middle', () => {
    for (const address of SAMPLE) {
      for (const row of identicon(address).cells) {
        for (let x = 0; x < IDENTICON_SIZE; x++) {
          expect(row[x], `${address} column ${x}`).toBe(row[IDENTICON_SIZE - 1 - x])
        }
      }
    }
  })

  // A grid of fifteen zeroes is a blank square, which reads as an avatar that
  // failed to load. `0x40e4` is an address that hashes to exactly that, found by
  // search, and it is here so the floor underneath it is actually exercised
  // rather than assumed.
  it('never draws a blank square, including for an address that hashes to one', () => {
    expect(painted(identicon('0x40e4'))).toBe(1)
    for (const address of SAMPLE) expect(painted(identicon(address)), address).toBeGreaterThan(0)
  })

  it('picks an ink from the ramp and nothing else', () => {
    for (const address of SAMPLE) expect(IDENTICON_INK).toContain(identicon(address).color)
  })
})

describe('a crowd of accounts', () => {
  it('gives all but a handful of a large sample their own picture', () => {
    const distinct = new Set(SAMPLE.map(fingerprint)).size

    // Fifteen free cells and three inks make 98 304 pictures, so a sample this
    // size is expected to contain a collision or two by the birthday bound
    // alone — 512 x 511 / (2 x 98 304) is about 1.3. That is arithmetic, and
    // asserting perfection here would only be recording today's luck. A hash
    // that has actually gone wrong clusters, sending dozens of addresses to the
    // same picture, so the bar sits well above the expected handful and far
    // below that.
    expect((SAMPLE.length * (SAMPLE.length - 1)) / (2 * POSSIBLE_IMAGES)).toBeLessThan(2)
    expect(distinct).toBeGreaterThan(SAMPLE.length * 0.98)
  })

  // The case a weak hash fails: two addresses a single nibble apart. Without an
  // avalanche step these differ in one cell, which is exactly the pair a reader
  // needs to tell apart.
  it('separates addresses that differ in a single character', () => {
    const base = fingerprint(CHECKSUMMED)
    for (const variant of NEIGHBOURS) expect(fingerprint(variant), variant).not.toBe(base)

    const distinct = new Set(NEIGHBOURS.map(fingerprint)).size
    expect(distinct).toBeGreaterThan(NEIGHBOURS.length * 0.98)
  })

  it('reaches for every ink rather than favouring one', () => {
    const counts = new Map<string, number>()
    for (const address of SAMPLE) {
      const { color } = identicon(address)
      counts.set(color, (counts.get(color) ?? 0) + 1)
    }

    const even = SAMPLE.length / IDENTICON_INK.length
    for (const ink of IDENTICON_INK) expect(counts.get(ink) ?? 0, ink).toBeGreaterThan(even / 2)
  })

  // A cell that is nearly always on, or nearly always off, is a cell carrying no
  // information, and fifteen of those is a wall of identical avatars.
  it('paints each cell about half the time', () => {
    const hits = new Array<number>(IDENTICON_SIZE * IDENTICON_SIZE).fill(0)
    for (const address of SAMPLE) {
      const { cells } = identicon(address)
      for (let y = 0; y < IDENTICON_SIZE; y++) {
        for (let x = 0; x < IDENTICON_SIZE; x++) {
          const cell = y * IDENTICON_SIZE + x
          if (cells[y]![x]) hits[cell] = (hits[cell] ?? 0) + 1
        }
      }
    }

    for (const [index, count] of hits.entries()) {
      expect(count / SAMPLE.length, `cell ${index}`).toBeGreaterThan(0.35)
      expect(count / SAMPLE.length, `cell ${index}`).toBeLessThan(0.65)
    }
  })
})

// The bar the palette already holds itself to, applied to the ink. An avatar is
// a non-text graphic, so AA_NON_TEXT is the right threshold — and it has to hold
// on every surface, because the avatar sits in a message bubble on `bgElevated`,
// in one of your own on `bgElevated2`, and on the page itself in a member list.
describe.each([['dark', DARK]])('%s surfaces', (_name, p: Palette) => {
  it('every ink an identicon can pick stays visible on every surface', () => {
    for (const ink of IDENTICON_INK) {
      for (const bg of [p.bg, p.bgElevated, p.bgElevated2]) {
        expect(contrastRatio(ink, bg), `${ink} on ${bg}`).toBeGreaterThanOrEqual(AA_NON_TEXT)
      }
    }
  })
})

describe('identicon ink', () => {
  // Generating a hue from the hash is the easy version and it makes avatars that
  // belong to no product in particular. Everything here is a colour the design
  // system already owns, so a wall of them still looks like Lightchain.
  it('draws only on colours the product already owns', () => {
    // `Object.values` on these falls to its `any[]` overload — none of them has
    // an index signature — so the strings are picked out rather than spread in
    // blind. This is the same set as before: the nested `neutral` ramp came
    // through as an object and could never have matched a colour lookup.
    const coloursIn = (source: object): string[] =>
      (Object.values(source) as unknown[]).filter(
        (value): value is string => typeof value === 'string'
      )

    const owned = new Set<string>([...coloursIn(BRAND), ...coloursIn(DARK)])
    for (const ink of IDENTICON_INK) expect(owned.has(ink), ink).toBe(true)
  })

  it('has no duplicates in it', () => {
    expect(new Set(IDENTICON_INK).size).toBe(IDENTICON_INK.length)
  })
})

describe('identicon SVG', () => {
  const svg = identiconSvg(CHECKSUMMED, 32)

  it('carries nothing the content policy would refuse', () => {
    for (const forbidden of [/script/i, /\bstyle\b/i, /href/i, /data:/i, /\son[a-z]+\s*=/i]) {
      expect(svg, String(forbidden)).not.toMatch(forbidden)
    }
  })

  // Stronger than a list of things that must be absent: this is the list of
  // everything that may be present. Nothing can hide in the output that is not
  // a number this module counted or a colour from the ramp.
  it('emits nothing but the shapes it counted out', () => {
    const shape =
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 5 5"( width="\d+" height="\d+")? shape-rendering="crispEdges" aria-hidden="true"><g fill="#[0-9a-f]{6}">(<rect x="\d" y="\d" width="1" height="1"\/>)+<\/g><\/svg>$/
    expect(svg).toMatch(shape)
    expect(identiconSvg(CHECKSUMMED)).toMatch(shape)
    for (const address of SAMPLE.slice(0, 64)) expect(identiconSvg(address), address).toMatch(shape)
  })

  // Nothing from the source reaches the output, so there is no escaping to get
  // wrong. A caller that hands this a hostile string gets an ordinary avatar.
  it('cannot be persuaded to emit anything from its input', () => {
    const hostile = '0x"><script>alert(1)</script><svg onload="alert(2)'
    const out = identiconSvg(hostile)
    expect(out).not.toContain('alert')
    expect(out).not.toContain('<script')
    expect(out).not.toMatch(/\son[a-z]+\s*=/i)
  })

  it('paints with a presentation attribute, which the policy allows', () => {
    expect(svg).toContain(`fill="${identicon(CHECKSUMMED).color}"`)
  })

  it('has one rect for every painted cell', () => {
    for (const address of SAMPLE.slice(0, 64)) {
      const rects = identiconSvg(address).match(/<rect /g) ?? []
      expect(rects, address).toHaveLength(painted(identicon(address)))
    }
  })

  it('takes a pixel size when it is given one and leaves sizing to CSS when not', () => {
    expect(identiconSvg(CHECKSUMMED, 40)).toContain('width="40" height="40"')
    expect(identiconSvg(CHECKSUMMED)).not.toContain('width="40"')
    expect(identiconSvg(CHECKSUMMED)).toContain('viewBox="0 0 5 5"')
  })

  it('refuses a size that is not a positive number of pixels', () => {
    for (const bad of [0, -8, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => identiconSvg(CHECKSUMMED, bad), String(bad)).toThrow(/positive number of pixels/)
    }
  })

  it('is the same string for the same address', () => {
    expect(identiconSvg(CHECKSUMMED, 32)).toBe(identiconSvg(CHECKSUMMED.toLowerCase(), 32))
  })
})
