/**
 * Builds the icon sprite in index.html from Lucide.
 *
 * The icons here used to be drawn by hand, one path at a time, on a 16px grid
 * that nothing else in the world uses. That is the single most reliable way to
 * make an application look homemade: every icon is slightly off from every
 * other one in weight, in optical size, and in how a corner is rounded, and no
 * amount of care fixes it because the errors are not individually visible.
 *
 * Lucide is one family drawn on a 24px grid at a 2px stroke by people who do
 * only this. Taking it wholesale means the set is internally consistent, and
 * adding an icon later is a line in the map below rather than an afternoon in a
 * path editor.
 *
 * The sprite is written into index.html rather than fetched at runtime. An
 * external sprite would be a second request that has to succeed before the
 * interface has any icons, and `<use href="other.svg#id">` is exactly the kind
 * of cross-document reference the content security policy is there to stop.
 *
 *     node scripts/build-icons.mjs [--check]
 *
 * `--check` fails instead of writing, for CI.
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.join(here, '..')
// The sprite's own partial, not the assembled document. index.html is written
// by build-markup.mjs and anything put there directly is lost on the next run.
const markup = path.join(app, 'renderer', 'partials', 'sprite.html')

// Asked for rather than guessed at. pnpm hoists to the workspace root, so the
// package is not under this app's own node_modules and a path built by hand
// finds nothing.
const require = createRequire(import.meta.url)
const lucide = path.join(path.dirname(require.resolve('lucide-static/package.json')), 'icons')

const START = '<!-- icons:start -->'
const END = '<!-- icons:end -->'

/**
 * Our name for an icon, and the Lucide file behind it.
 *
 * Ours are named for the job rather than the picture — `i-worker`, not
 * `i-server` — because the job is what the markup is talking about and the
 * picture is a decision this map is allowed to revisit.
 */
const ICONS = {
  // Navigation
  'i-chat': 'message-square',
  'i-models': 'sparkles',
  'i-worker': 'server',
  'i-wallet': 'wallet',
  'i-bridge': 'arrow-left-right',

  // Chrome
  'i-settings': 'settings',
  'i-collapse': 'panel-left-close',
  'i-expand': 'panel-left-open',
  'i-chevron': 'chevron-right',
  // Going back out of a nested pane, which the wallet's per-asset view is.
  'i-chevron-left': 'chevron-left',
  'i-sun': 'sun',
  'i-moon': 'moon',
  'i-search': 'search',
  'i-bell': 'bell',

  // State
  'i-lock': 'lock',
  'i-eye': 'eye',
  'i-eye-off': 'eye-off',
  'i-check': 'check',
  // Sent versus read on your own messages: one tick, then two.
  'i-check-check': 'check-check',
  'i-alert': 'triangle-alert',
  'i-info': 'info',
  'i-clock': 'clock',

  // Actions
  'i-plus': 'plus',
  'i-download': 'arrow-down-to-line',
  'i-upload': 'arrow-up-from-line',
  'i-copy': 'copy',
  'i-external': 'external-link',
  'i-refresh': 'refresh-cw',
  'i-close': 'x',
  'i-more': 'ellipsis',

  // On a message. These replace four unicode characters from four different
  // corners of the standard — an arrow, a smiling face, a pencil and a
  // multiplication sign — two of which Windows rendered through the emoji font,
  // in colour, at a size nothing else on the row used.
  'i-reply': 'corner-up-left',
  'i-react': 'smile-plus',
  'i-edit': 'pencil',
  'i-withdraw': 'trash-2',
  'i-again': 'rotate-cw',
  'i-pin': 'pin',
  'i-attach': 'paperclip',
  'i-send': 'arrow-up',
  // The pair of it. The markup referenced `#i-receive` in two places with no
  // symbol behind it, so the button's icon painted nothing at all.
  'i-receive': 'arrow-down',

  // In a room
  'i-members': 'users',
  'i-leave': 'log-out',
  'i-rename': 'square-pen',
  'i-invite': 'user-plus',

  // Worker and wallet
  'i-play': 'play',
  'i-stop': 'square',
  'i-container': 'box',
  'i-terminal': 'terminal',
  'i-cpu': 'cpu',
  'i-key': 'key',
  'i-shield': 'shield-check',

  'i-routing': 'route',
  // Swapping, beside bridge's left-right arrows: the pair trade vertical.
  'i-swap': 'arrow-down-up',
  'i-storage': 'database'
}

/** Lucide ships whole documents; the sprite wants only what is inside them. */
function symbolFor(name, file) {
  const source = fs.readFileSync(path.join(lucide, `${file}.svg`), 'utf8')
  const body = source
    .replace(/[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    // Stroke width, cap and join are set once in the stylesheet so the whole
    // set changes together and so an icon inherits the colour of its text.
    // Repeated here they would be attributes CSS cannot reach.
    .replace(/\s(stroke|fill|stroke-width|stroke-linecap|stroke-linejoin)="[^"]*"/g, '')
    .trim()
    .split('\n')
    .map((line) => `          ${line.trim()}`)
    .join('\n')

  return `        <symbol id="${name}" viewBox="0 0 24 24">\n${body}\n        </symbol>`
}

const missing = Object.values(ICONS).filter(
  (file) => !fs.existsSync(path.join(lucide, `${file}.svg`))
)
if (missing.length > 0) {
  console.error(`lucide has no icon named: ${missing.join(', ')}`)
  process.exit(1)
}

const sprite = Object.entries(ICONS)
  .map(([name, file]) => symbolFor(name, file))
  .join('\n')

const html = fs.readFileSync(markup, 'utf8')
const from = html.indexOf(START)
const to = html.indexOf(END)

if (from === -1 || to === -1) {
  console.error(`partials/sprite.html is missing the ${START} / ${END} markers`)
  process.exit(1)
}

const next = `${html.slice(0, from + START.length)}\n${sprite}\n        ${html.slice(to)}`

if (process.argv.includes('--check')) {
  if (next !== html) {
    console.error('partials/sprite.html is out of date; run node scripts/build-icons.mjs')
    process.exit(1)
  }
  console.log(`icon sprite is current (${Object.keys(ICONS).length} icons)`)
} else {
  fs.writeFileSync(markup, next)
  console.log(`wrote ${Object.keys(ICONS).length} icons into renderer/partials/sprite.html`)
}
