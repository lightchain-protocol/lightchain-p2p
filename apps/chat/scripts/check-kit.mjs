/**
 * Fails when a surface stylesheet redefines a shared component.
 *
 * The surface sheets load after the kit, so a surface that declares a rule for
 * a kit class does not merely style its own copy — it silently replaces that
 * component everywhere in the application. Three of these were found in one
 * evening, each invisible in the panel that caused it:
 *
 *   - worker.css redefined `.facts`, so the encryption dialog and three lists
 *     in Settings rendered with the Worker page's label column.
 *   - dashboard.css redefined `.chip`, so the room header, the encryption
 *     dialog and the Worker panel all got the Dashboard's chip.
 *   - room.css owned `.badge`, which the Wallet was borrowing.
 *
 * None of them produced an error, a warning, or a symptom on the page whose
 * stylesheet was at fault. They can only be found by looking at two surfaces at
 * once, which is exactly what nobody does.
 *
 *     node scripts/check-kit.mjs
 *
 * A surface may still *extend* a kit component through its own class or a
 * descendant selector — `.sidebar .chip` is scoped and deliberate. What this
 * refuses is a bare redeclaration of the class itself.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const styles = path.join(here, '..', 'renderer', 'styles')
const kitFile = path.join(styles, 'kit.css')

/** Class names a stylesheet declares rules for, ignoring scoped selectors. */
function classesIn(source) {
  const found = new Set()

  // Selector lists only: everything before a `{` that is not inside a block,
  // an at-rule prelude, or a declaration.
  for (const match of source.matchAll(/(^|\})([^{}@]+)\{/g)) {
    for (const selector of match[2].split(',')) {
      const trimmed = selector.trim()
      if (trimmed === '' || trimmed.startsWith('@')) continue

      // A bare class, optionally with its own pseudo-classes, states or
      // attribute qualifiers — but not descended from anything else, because
      // that is a surface scoping a component rather than replacing it.
      const bare = /^\.([a-z][a-z0-9-]*)((:{1,2}[a-z-]+(\([^)]*\))?)|(\[[^\]]*\]))*$/i.exec(trimmed)
      if (bare) found.add(bare[1])
    }
  }

  return found
}

const kit = classesIn(fs.readFileSync(kitFile, 'utf8'))

const clashes = []
for (const entry of fs.readdirSync(styles)) {
  if (!entry.endsWith('.css') || entry === 'kit.css') continue

  const source = fs.readFileSync(path.join(styles, entry), 'utf8')
  for (const name of classesIn(source)) {
    if (kit.has(name)) clashes.push({ file: entry, name })
  }
}

if (clashes.length > 0) {
  console.error(`${clashes.length} surface rule(s) redeclare a kit component:\n`)
  for (const { file, name } of clashes) console.error(`  styles/${file}  .${name}`)
  console.error('\nSurface sheets load after the kit, so this replaces the component everywhere.')
  console.error('Scope it (.worker .chip) if the surface needs its own, or change the kit.')
  process.exit(1)
}

/**
 * Controls that are drawn once for the whole application.
 *
 * `classesIn` only sees class selectors, so a component addressed by element
 * and attribute is invisible to it. The checkbox was drawn three times before
 * anybody noticed — once shared, once by the bridge and once by settings — and
 * two of those set `appearance: none` and drew a tick, so a single box rendered
 * two ticks of different shapes inside a border of a third size.
 *
 * A surface may position one of these. It may not restyle one: that is how a
 * second implementation starts.
 */
const SOLE = ["input[type='checkbox']"]
const restyled = []

for (const entry of fs.readdirSync(styles)) {
  if (!entry.endsWith('.css') || entry === 'kit.css') continue
  const source = fs.readFileSync(path.join(styles, entry), 'utf8')

  // Every `selector { declarations }` pair. Nested at-rules still yield their
  // inner rules, which is what matters here.
  for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = selector.trim()
    if (head.startsWith('@')) continue

    for (const control of SOLE) {
      if (!head.includes(control)) continue

      // Placing one is fine. Redrawing one is not.
      const draws = /(^|[\s;])(appearance|width|height|border|background|border-radius)\s*:/.test(
        body
      )
      if (draws) restyled.push(`${entry}: ${head} redraws ${control}`)
    }
  }
}

if (restyled.length > 0) {
  console.error('\nA surface redraws a control the kit already draws:\n')
  for (const line of restyled) console.error(`  ${line}`)
  console.error('\nPosition it if you must; draw it once, in app.css.')
  process.exitCode = 1
}

console.log(`no surface redeclares a kit component (${kit.size} shared classes)`)
