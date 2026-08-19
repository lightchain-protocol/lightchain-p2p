/**
 * Deterministic avatars, derived from an account address.
 *
 * A room where everybody is `0xD140…7aBe` is a room where nobody can tell who is
 * speaking. Forty hex characters all look alike at a glance, and the handful the
 * interface keeps when it shortens one are the handful an impostor would choose
 * to match.
 *
 * The two usual answers are both unavailable here. A fetched avatar is refused by
 * the renderer's `default-src 'self'` policy before it reaches the network, and
 * opening that policy up to images from anywhere is a large concession for a
 * small feature. An uploaded avatar is worse: it is a file that every member of
 * the room replicates for as long as the room exists, and a channel for putting
 * whatever imagery its owner likes in front of people who came to read messages.
 *
 * Deriving the picture from the address needs no network, no storage, no
 * moderation and no change to the policy, and it takes away the "set my picture
 * to look like yours" move that uploads hand to an impersonator.
 *
 * It is still a recognition aid rather than a credential, and it should not be
 * described as if it were more. There are 98 304 possible pictures, so somebody
 * who wants an account that looks like yours can generate keys until one does,
 * which is seconds of work. What the avatar earns is the glance: a familiar
 * account that is suddenly a different shape is worth a second look. The address
 * underneath remains the thing that is actually checked.
 */

import { BRAND, LIGHT } from './tokens.js'

/** Grid edge length, in cells. */
export const IDENTICON_SIZE = 5

/**
 * The colours an identicon can be drawn in.
 *
 * Avatars are painted straight onto whatever surface they land on, with no tile
 * behind them, so each colour has to hold up against all six surface tokens: the
 * page, the panel and the raised panel, in both themes. A message bubble is
 * `bgElevated` and one of your own is `bgElevated2`, so this is where avatars
 * actually sit rather than a theoretical worst case. Picking a colour per theme
 * is not an option either — the renderer switches theme by setting an attribute
 * on `:root` and nothing re-renders, so whatever is on screen has to survive the
 * switch.
 *
 * That is a narrower requirement than it sounds. Legibility on both `#ffffff`
 * and `#06060e` confines a colour to a band of mid-tones, and most of the
 * palette is deliberately tuned to one end or the other: the light violets wash
 * out on white, the dark ones disappear into near-black. Three tokens survive,
 * and `identicon.test.ts` holds them to the same bar the palette itself is held
 * to.
 *
 * `BRAND.border` survives too and is deliberately absent. It is eleven units of
 * CIE76 from `BRAND.violet`, which is to say the same colour to anyone glancing
 * at a 32px square, and a fourth colour nobody can tell from the first is not a
 * fourth colour. `LIGHT.success` is here for its value and not its meaning —
 * nothing about a green avatar says success; it is simply the only non-violet
 * mid-tone the palette owns.
 */
export const IDENTICON_INK: readonly string[] = [BRAND.violet, BRAND.magenta, LIGHT.success]

/**
 * Columns drawn from the hash. The remainder of each row is their reflection,
 * which is what makes a handful of coin flips read as a deliberate mark rather
 * than as static: the eye takes symmetry for a shape and remembers shapes.
 */
const DRAWN_COLUMNS = Math.ceil(IDENTICON_SIZE / 2)

/** One bit per drawn cell. The colour is chosen from the bits left over. */
const PATTERN_BITS = IDENTICON_SIZE * DRAWN_COLUMNS

export interface Identicon {
  /** Edge length in cells; always `IDENTICON_SIZE`. */
  readonly size: number
  /** Row-major. `cells[y][x]` is `true` where the ink is painted. */
  readonly cells: readonly (readonly boolean[])[]
  /** The ink colour, one of `IDENTICON_INK`. */
  readonly color: string
}

/**
 * FNV-1a, 32 bits, over the code units of the input.
 *
 * The picture has to come out the same on every machine and every run, forever,
 * which rules out anything seeded but does not call for a cryptographic hash.
 * The grid has fifteen free cells and three inks, so there are 98 304 possible
 * pictures however wide the digest is; SHA-256 would spread addresses across
 * that space no more evenly than this does, and would cost the package its first
 * dependency to do it.
 *
 * Each code unit goes in as two bytes rather than as UTF-8 because the package
 * compiles against ES2022 with no platform globals and `TextEncoder` is not one
 * of them. Splitting the unit is exact for every string and asks nothing of the
 * host.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193)
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193)
  }
  return hash >>> 0
}

/**
 * MurmurHash3's finaliser, applied to the digest before any of it is read.
 *
 * FNV-1a's low bits barely move. Its prime is odd, so the bottom bit of the
 * digest is no more than the parity of the bottom bit of every byte that went
 * in, and the next few are only slightly better. The grid reads one bit per
 * cell straight off the bottom of the word, so without this two addresses
 * differing in a single nibble would draw two grids differing in a single cell —
 * exactly the pairs that most need to look unalike. Two multiplies and three
 * shifts avalanche the word so that every bit depends on every input byte.
 */
function avalanche(hash: number): number {
  let h = hash
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Reduces a source string to the identity it stands for.
 *
 * Case has to go: an EIP-55 checksummed address and its lower-case form are one
 * account, and a wallet that shows one while the room stores the other must not
 * produce two different people. `toLowerCase` and not `toLocaleLowerCase` — the
 * locale-aware form maps `I` to a dotless `ı` under a Turkish locale, which
 * would hand the same account a different avatar depending on the regional
 * settings of the machine drawing it.
 *
 * The `0x` prefix comes off for the same reason, so that a bare hex key and the
 * prefixed spelling of the same value are one identity rather than two.
 *
 * An empty source is refused rather than hashed. There is a perfectly good
 * picture for the empty string, and drawing it would mean an address that failed
 * to load renders as a confident avatar for nobody — the kind of bug that looks
 * like a feature until someone trusts it.
 */
function normalise(source: string): string {
  const trimmed = source.trim()
  if (trimmed === '') {
    throw new Error('identicon needs a source to derive from; got an empty string')
  }

  const lower = trimmed.toLowerCase()
  return lower.startsWith('0x') ? lower.slice(2) : lower
}

/**
 * Describes the avatar for an address, or for any other stable string.
 *
 * Returns the grid rather than a picture so that the caller can decide what to
 * build from it. The renderer assembles DOM nodes directly, which keeps it clear
 * of markup strings entirely; `identiconSvg` is here for everything else.
 */
export function identicon(source: string): Identicon {
  const hash = avalanche(fnv1a(normalise(source)))

  const cells: boolean[][] = []
  let painted = 0

  for (let y = 0; y < IDENTICON_SIZE; y++) {
    const row: boolean[] = new Array<boolean>(IDENTICON_SIZE).fill(false)
    for (let x = 0; x < DRAWN_COLUMNS; x++) {
      if (((hash >>> (y * DRAWN_COLUMNS + x)) & 1) === 0) continue
      row[x] = true
      row[IDENTICON_SIZE - 1 - x] = true
      painted++
    }
    cells.push(row)
  }

  // One address in 32 768 hashes to fifteen zeroes and draws nothing at all. In
  // a room of any size that is a matter of when rather than whether, and a blank
  // square where an avatar should be reads as a loading failure. The centre cell
  // is the least disruptive floor to put under it.
  if (painted === 0) {
    const centre = Math.floor(IDENTICON_SIZE / 2)
    cells[centre]![centre] = true
  }

  // Bits the grid did not consume, so pattern and colour vary independently and
  // two addresses that happen to share a pattern usually still differ.
  const color = IDENTICON_INK[(hash >>> PATTERN_BITS) % IDENTICON_INK.length]!

  return { size: IDENTICON_SIZE, cells, color }
}

/**
 * Renders an identicon as an SVG document string.
 *
 * Safe to insert into the page by construction rather than by sanitising: no
 * part of `source` reaches the output. Everything in the string is either a
 * small integer this function counted out or a colour from `IDENTICON_INK`, so
 * there is no escaping to get wrong and nothing an input can do to close a tag.
 *
 * Colour arrives as a `fill` attribute on the group rather than as CSS because
 * `style-src 'self'` covers the inline `style` attribute as well as `<style>`
 * blocks, and anything set that way would simply be dropped. The one URL in the
 * output is the SVG namespace name, which identifies the dialect and is never
 * dereferenced; there are no references to fetch, no scripts and no handlers.
 *
 * There is deliberately no `data:` URL counterpart. The same policy blocks
 * `data:` in an `<img>`, so such a function could only ever hand a caller a
 * broken image, and the failure would show up as a missing avatar rather than as
 * an error anyone could trace back to here.
 *
 * `pixels` is optional. Left out, the element carries only a `viewBox` and takes
 * whatever size the stylesheet gives it, which is the usual case; passed, it
 * fixes the size for contexts with no stylesheet to consult.
 */
export function identiconSvg(source: string, pixels?: number): string {
  if (pixels !== undefined && (!Number.isFinite(pixels) || pixels <= 0)) {
    throw new Error(`identicon size must be a positive number of pixels; got ${pixels}`)
  }

  const { size, cells, color } = identicon(source)

  const rects: string[] = []
  for (let y = 0; y < size; y++) {
    const row = cells[y]!
    for (let x = 0; x < size; x++) {
      if (row[x]) rects.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`)
    }
  }

  const sizing = pixels === undefined ? [] : [`width="${pixels}"`, `height="${pixels}"`]

  const attributes = [
    'xmlns="http://www.w3.org/2000/svg"',
    `viewBox="0 0 ${size} ${size}"`,
    ...sizing,
    // Five cells across an arbitrary box put most edges on fractional pixels,
    // and the antialiasing where two painted cells meet shows up as a pale seam
    // through the middle of what should be one solid shape. Snapping to whole
    // pixels leaves the occasional cell a pixel wider than its neighbour, which
    // nobody has ever noticed on a 32px square.
    'shape-rendering="crispEdges"',
    // Hidden from assistive technology on purpose: the pattern carries no
    // meaning that can be read out, and the address it stands for is always on
    // screen as text beside it. A caller that shows an avatar on its own owns
    // the job of labelling whatever it sits in.
    'aria-hidden="true"'
  ]

  return `<svg ${attributes.join(' ')}><g fill="${color}">${rects.join('')}</g></svg>`
}
