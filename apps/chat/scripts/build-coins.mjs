/**
 * Asset marks, bundled into the sprite rather than fetched.
 *
 * A wallet listing assets wants their logos, and every wallet that shows them
 * loads them from a CDN. This one cannot: the renderer's policy is
 * `img-src 'self' blob:` with no network origin, deliberately, because room
 * content is written by strangers and must not be able to phone home. Relaxing
 * that for prettier icons would be trading a real protection for decoration.
 *
 * So the marks are compiled in. `cryptocurrency-icons` is CC0, which is what
 * makes vendoring them into the sprite a thing that can simply be done.
 *
 * Full colour, unlike the interface icons: these are brand marks and a
 * monochrome Bitcoin logo is not a Bitcoin logo. That is also why they are a
 * separate sprite pass — the Lucide set is stroked and inherits `currentColor`,
 * and mixing the two rules in one file would confuse both.
 *
 *     node scripts/build-coins.mjs [--check]
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const icons = path.join(
  path.dirname(require.resolve('cryptocurrency-icons/package.json')),
  'svg/color'
)

const here = path.dirname(fileURLToPath(import.meta.url))
const sprite = path.join(here, '..', 'renderer', 'partials', 'sprite.html')

/**
 * Which mark stands for which asset, by the symbol the worker reports.
 *
 * Several are deliberate substitutions rather than gaps:
 *
 * - Wrapped tokens borrow the mark of what they wrap. WETH is ether and WBTC
 *   is bitcoin, as far as somebody scanning a list is concerned, and the row
 *   already says which one it is in words.
 * - POL uses the MATIC mark, because the token was renamed and the icon set
 *   has not caught up. It is the same asset.
 * - Tether's renamed variants use the Tether mark. `USD₮0` on Arbitrum is
 *   still Tether.
 */
const COINS = {
  'c-btc': 'btc',
  'c-eth': 'eth',
  'c-usdc': 'usdc',
  'c-usdt': 'usdt',
  'c-dai': 'dai',
  'c-wbtc': 'wbtc',
  'c-weth': 'eth',
  'c-bnb': 'bnb',
  'c-pol': 'matic',
  'c-arb': 'generic',
  'c-generic': 'generic'
}

const START = '<!-- coins:start -->'
const END = '<!-- coins:end -->'

/**
 * One file's contents as a `<symbol>`.
 *
 * The width, height and xmlns go: a symbol takes its size from where it is
 * used, and repeating the namespace in every one of them is bytes for nothing.
 * The viewBox stays, because without it nothing scales.
 */
function symbolFor(id, file) {
  const source = fs.readFileSync(path.join(icons, `${file}.svg`), 'utf8')

  const viewBox = source.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 32 32'
  const body = source
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>/, '')
    .replace(/\s+/g, ' ')
    .trim()

  return `        <symbol id="${id}" viewBox="${viewBox}">${body}</symbol>`
}

const built = Object.entries(COINS)
  .map(([id, file]) => symbolFor(id, file))
  .join('\n')

const current = fs.readFileSync(sprite, 'utf8')

// Its own region, so the Lucide pass and this one can each rewrite their half
// without either needing to know what the other put there.
const region = current.includes(START)
  ? current.replace(new RegExp(`${START}[\\s\\S]*?${END}`), `${START}\n${built}\n        ${END}`)
  : current.replace('</svg>', `        ${START}\n${built}\n        ${END}\n      </svg>`)

if (process.argv.includes('--check')) {
  if (region !== current) {
    console.error('the coin marks are out of date; run node scripts/build-coins.mjs')
    process.exit(1)
  }
  console.log(`coin marks are current (${Object.keys(COINS).length} marks)`)
} else {
  fs.writeFileSync(sprite, region)
  console.log(`wrote ${Object.keys(COINS).length} coin marks into renderer/partials/sprite.html`)
}
