/**
 * Fails when a stylesheet styles a class nothing ever wears.
 *
 * Renames are what produce these. A class is renamed in the markup and the old
 * rule stays behind, still valid CSS, still parsed on every load, and matching
 * nothing. `.ledger` outlived its rename to `.unbuilt-legend` and
 * `.attachment-tray` outlived `.composer-tray`, both carrying comments
 * describing layouts that no element had.
 *
 * Dead rules are not merely waste. The next person to style that surface finds
 * two plausible rules and no way to tell which one is live, and the honest
 * answer — neither, one of them is a ghost — is the one nothing tells them.
 *
 *     node apps/chat/scripts/check-css.mjs
 *
 * A name is considered used if it appears anywhere in the markup or the
 * scripts, as a substring. Deliberately lenient: classes here are sometimes
 * assembled by concatenation, and a check that cried wolf over those would be
 * turned off within a week.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const sheets = [
  ...fs
    .readdirSync(path.join(root, 'renderer/styles'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `renderer/styles/${f}`),
  'renderer/app.css'
]

const defined = new Map()
for (const file of sheets) {
  const css = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]{2,})/g)) {
    if (!defined.has(match[1])) defined.set(match[1], file)
  }
}

let source = ''
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skipped, or every selector would count as its own use.
      if (entry.name !== 'styles') walk(full)
      continue
    }
    if (/\.(js|mjs|html)$/.test(entry.name)) source += fs.readFileSync(full, 'utf8')
  }
}

walk(path.join(root, 'renderer'))
for (const file of ['electron/main.js', 'electron/preload.js']) {
  source += fs.readFileSync(path.join(root, file), 'utf8')
}

const orphans = [...defined].filter(([name]) => !source.includes(name))

if (orphans.length > 0) {
  console.error('These classes are styled and never worn:\n')
  for (const [name, file] of orphans.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  .${name}  <- ${file}`)
  }
  console.error('\nDelete the rule, or use the class.')
  process.exit(1)
}

console.log(`${defined.size} classes styled, all of them worn`)
