/**
 * Fails when a stylesheet reads a design token that nothing defines.
 *
 * CSS has no error for this. `color: var(--lc-typo)` is not invalid — the
 * declaration is simply dropped, and the element keeps whatever it would have
 * had otherwise. So a misspelled token is invisible: the build passes, the
 * linter passes, the type checker passes, every harness passes, and the only
 * symptom is a control that quietly has no background or no focus ring.
 *
 * That is exactly how the message hover toolbar ended up transparent. It read
 * `--lc-bg-elevated2`, the palette defines `--lc-bg-elevated-2`, and nothing
 * anywhere said so. Five names were dead across ten declarations, including two
 * focus rings that therefore did not exist.
 *
 *     node scripts/check-tokens.mjs
 *
 * A token with a fallback — `var(--lc-maybe, 8px)` — is deliberate and passes.
 * The fallback is the author saying the name is optional.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const renderer = path.join(here, '..', 'renderer')

/** Every stylesheet the window loads, generated or hand-written. */
function stylesheets(dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...stylesheets(full))
    else if (entry.name.endsWith('.css')) found.push(full)
  }
  return found
}

const files = stylesheets(renderer)
const sources = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))

/**
 * What is defined anywhere, in any selector.
 *
 * Deliberately not scoped to `:root`. A token defined only under
 * `[data-theme='light']` is still defined, and a checker that demanded one
 * canonical home would be enforcing a rule this codebase has not agreed to.
 */
const defined = new Set()
for (const source of sources.values()) {
  for (const match of source.matchAll(/(--lc-[a-z0-9-]+)\s*:/g)) defined.add(match[1])
}

// The capture stops at a comma so that `var(--lc-x, fallback)` is recognised as
// having one, and the trailing group tells us which form this is.
const USE = /var\(\s*(--lc-[a-z0-9-]+)\s*(,)?/g

const dead = []
for (const [file, source] of sources) {
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(USE)) {
      const [, name, fallback] = match
      if (fallback || defined.has(name)) continue
      dead.push({ file: path.relative(renderer, file), line: index + 1, name })
    }
  })
}

if (dead.length > 0) {
  console.error(`${dead.length} declaration(s) read a token that nothing defines:\n`)
  for (const { file, line, name } of dead) console.error(`  ${file}:${line}  ${name}`)

  const names = [...new Set(dead.map((d) => d.name))]
  console.error(`\n${names.length} undefined name(s): ${names.join(', ')}`)
  console.error('Define them in packages/ui/src/tokens.ts, or use a name that exists.')
  process.exit(1)
}

console.log(`every token resolves (${defined.size} defined, across ${files.length} stylesheets)`)
