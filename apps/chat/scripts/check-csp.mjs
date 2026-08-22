/**
 * Fails when the renderer ships something its own policy will refuse.
 *
 * A blocked resource is not an error anybody sees. The element stays in the
 * document with the right class and the wrong size, the background image simply
 * never paints, and the page looks almost correct — so this fails quietly, for
 * as long as nobody measures it. Two whole classes of it had been shipping:
 *
 *   - Thirteen `style` attributes, every one dropped, every placeholder they
 *     sized collapsed to nothing.
 *   - The `data:` URI chevron on every `<select>` in the application, which
 *     meant no dropdown had an affordance at all.
 *
 * Both looked right in the source and had been reviewed as such.
 *
 * ## The rules come from the policy
 *
 * Nothing here hard-codes what is allowed. The policy is parsed out of
 * index.html and each rule below asks it, so tightening or loosening the header
 * changes what this refuses without anybody remembering to update a list. A
 * policy that gained `'unsafe-inline'` for styles would make the style-attribute
 * rule stop firing, correctly.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const renderer = path.join(here, '..', 'renderer')
const indexFile = path.join(renderer, 'index.html')

const index = fs.readFileSync(indexFile, 'utf8')

const policyText = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(index)?.[1]
if (!policyText) {
  console.error(
    'renderer/index.html declares no Content-Security-Policy. Nothing to check against.'
  )
  process.exit(1)
}

/** `style-src 'self'` → `{ 'style-src': ["'self'"] }`, with the fallback applied. */
const policy = new Map(
  policyText
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/)
      return [name, values]
    })
)

const allows = (directive, token) =>
  (policy.get(directive) ?? policy.get('default-src') ?? []).includes(token)

/** Every file the policy governs, with a repo-relative name for the report. */
function filesUnder(dir, extensions) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full, extensions))
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full)
  }
  return found
}

const name = (file) => path.relative(path.join(here, '..'), file)

const markup = [indexFile, ...filesUnder(path.join(renderer, 'partials'), ['.html'])]
const styles = [
  path.join(renderer, 'app.css'),
  ...filesUnder(path.join(renderer, 'styles'), ['.css'])
]
const scripts = filesUnder(path.join(renderer, 'lib'), ['.js'])

const problems = []
const report = (file, line, what, why) =>
  problems.push({ where: `${name(file)}:${line}`, what, why })

/** Which line an index falls on, for a message somebody can act on. */
const lineOf = (source, index) => source.slice(0, index).split('\n').length

// --- Inline styles ----------------------------------------------------------
//
// `style-src` governs both `<style>` blocks and `style` attributes. Without
// `'unsafe-inline'` the attribute is dropped and the element keeps every other
// thing about it, which is why this was invisible for so long.
if (!allows('style-src', "'unsafe-inline'")) {
  for (const file of markup) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\sstyle="[^"]*"/g)) {
      report(file, lineOf(source, match.index), match[0].trim(), 'style-src has no ‘unsafe-inline’')
    }
    for (const match of source.matchAll(/<style[\s>]/g)) {
      report(file, lineOf(source, match.index), '<style> block', 'style-src has no ‘unsafe-inline’')
    }
  }
}

// --- Images from a data: URI -------------------------------------------------
//
// A CSS background is fetched under `img-src`, and a `data:` URI is a scheme
// that has to be listed. Blocked, the declaration parses, computes, and paints
// nothing.
if (!allows('img-src', 'data:')) {
  for (const file of [...styles, ...markup]) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/url\(\s*["']?data:/g)) {
      report(file, lineOf(source, match.index), 'url(data:…)', 'img-src does not list ‘data:’')
    }
  }
}

// --- Inline script and event attributes --------------------------------------
if (!allows('script-src', "'unsafe-inline'")) {
  for (const file of markup) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)) {
      report(
        file,
        lineOf(source, match.index),
        'inline <script>',
        'script-src has no ‘unsafe-inline’'
      )
    }
    // `onclick=` and friends are inline script by another spelling.
    for (const match of source.matchAll(/\son[a-z]+="[^"]*"/g)) {
      report(
        file,
        lineOf(source, match.index),
        match[0].trim().split('=')[0],
        'inline event handler'
      )
    }
  }
}

// --- Anything fetched from somewhere else ------------------------------------
//
// `default-src 'self'` means this window may fetch from itself. A stylesheet or
// a page that names a host is naming somewhere it cannot reach.
const REMOTE = /(?:url\(\s*["']?|src="|href=")(https?:)\/\/([^"')\s]+)/g
for (const file of [...styles, ...markup, ...scripts]) {
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(REMOTE)) {
    const origin = `${match[1]}//${new URL(`${match[1]}//${match[2]}`).host}`
    if (allows('default-src', origin)) continue
    // Links a person clicks leave this window entirely; the policy never sees
    // them. Only things the page itself fetches are governed.
    const clicked = /href="/.test(match[0]) && /\.html$/.test(file)
    if (clicked) continue
    report(file, lineOf(source, match.index), origin, 'default-src is ‘self’')
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} thing(s) this window's policy will silently refuse:\n`)
  for (const { where, what, why } of problems) {
    console.error(`  ${where}\n    ${what}  —  ${why}`)
  }
  console.error(`\nPolicy: ${policyText}\n`)
  console.error('Move it into a stylesheet, or change the policy deliberately.\n')
  process.exit(1)
}

console.log(
  `nothing the policy refuses (${markup.length} markup, ${styles.length} stylesheets, ${scripts.length} scripts)`
)
