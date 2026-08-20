/**
 * Fails when a surface uses the brand as a second colour rather than an accent.
 *
 * The rule this enforces is one sentence: *one accent per screen, and the raw
 * brand colours belong to the mark*. Neutral surfaces do the heavy lifting, and
 * the accent means "this is actionable" or "this is you".
 *
 *     node scripts/check-accent.mjs
 *
 * The accent has tints — `--lc-accent`, `--lc-accent-soft`, and the older
 * `--lc-brand` and `--lc-brand-ink` that alias it — and using several of those
 * on one surface is one accent, not four. What is refused is reaching past them
 * for `--lc-brand-violet`, `--lc-brand-magenta` or the logo gradient, which are
 * the mark's own colours and are more saturated than anything the interface
 * should put behind text.
 *
 * It found the primary button wearing a violet-to-magenta gradient, which is
 * the single most "crypto dashboard" thing in the stylesheet and which no
 * contrast test would ever object to.
 *
 * A rule may still use them where it is drawing the mark. That is decided by
 * the selector rather than by a list of files, so a new logo somewhere else
 * needs no permission and a button cannot quietly acquire it.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer')

/** The mark's own colours. Everything else in the family is one accent. */
const MARK_ONLY = ['--lc-brand-violet', '--lc-brand-magenta', '--lc-logo-from', '--lc-logo-to']

/** A selector that is drawing the mark, and may therefore use the mark's colours. */
const DRAWS_THE_MARK = /logo|wordmark|\bmark\b|brandmark/i

function sheets() {
  const found = [join(renderer, 'app.css')]
  const dir = join(renderer, 'styles')
  for (const name of readdirSync(dir)) if (name.endsWith('.css')) found.push(join(dir, name))
  return found
}

/**
 * Every rule in a stylesheet, as a selector and its declarations.
 *
 * Deliberately not a CSS parser. Splitting on braces is enough to attribute a
 * declaration to the selector above it, which is the only question here, and a
 * parser would be a dependency in a check that exists to have no excuses.
 */
function rules(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g

  let match
  while ((match = pattern.exec(withoutComments)) !== null) {
    found.push({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] })
  }

  return found
}

const problems = []
let checked = 0

for (const file of sheets()) {
  const name = file.slice(file.indexOf('renderer'))

  for (const rule of rules(readFileSync(file, 'utf8'))) {
    checked += 1
    if (DRAWS_THE_MARK.test(rule.selector)) continue

    const reached = MARK_ONLY.filter((token) => rule.body.includes(token))
    if (reached.length === 0) continue

    problems.push(`${name}  ${rule.selector}\n      uses ${reached.join(' and ')}`)
  }
}

if (problems.length > 0) {
  console.error("The mark's colours are being used as interface colour:\n")
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    '\nOne accent per screen. Use --lc-accent (or --lc-accent-soft for a tint).\n' +
      "--lc-brand-violet, --lc-brand-magenta and the logo gradient are the mark's,\n" +
      'and are only permitted in a rule whose selector draws it.'
  )
  process.exit(1)
}

console.log(`one accent per surface (${checked} rules across ${sheets().length} stylesheets)`)
