/**
 * Fails when two workspace packages ask for different majors of a Bare module.
 *
 * pnpm satisfies disagreeing ranges by nesting, which is usually a waste of
 * disk and occasionally much worse. `packages/inference` pinned
 * `bare-fetch: ^1.2.4` while everything else was on `^3.2.0`, so a whole second
 * network stack was installed underneath it — `bare-fetch`, `bare-http1`,
 * `bare-https`, `bare-tcp`, `bare-dns` and `bare-tls`, all two majors behind.
 *
 * That last one is why this check exists. `bare-tls` did not load a trust store
 * or reject an untrusted certificate until 3.0.0, so every call that package
 * made ran over TLS that verified nothing — and those are the calls carrying
 * prompts to the inference service and reading back the key each prompt is
 * sealed to. One worker, two TLS implementations, and the weaker one on the
 * traffic that mattered most.
 *
 *     node scripts/check-runtime-majors.mjs
 *
 * Nothing else would have caught it. Both versions install, both resolve, both
 * work, and the difference is a security property with no symptom.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where a `bare-*` range may legitimately differ, with a reason. */
const EXEMPT = new Set()

/** Every workspace manifest, by the path a person would recognise. */
function manifests() {
  const found = []

  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group)
    if (!fs.existsSync(dir)) continue

    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'package.json')
      if (fs.existsSync(file))
        found.push([`${group}/${name}`, JSON.parse(fs.readFileSync(file, 'utf8'))])
    }
  }

  return found
}

/** The major a range asks for, or null when it is not a plain range. */
function majorOf(range) {
  const match = /^[\^~]?(\d+)\./.exec(range)
  return match ? match[1] : null
}

const asked = new Map()

for (const [where, pkg] of manifests()) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  for (const [name, range] of Object.entries(deps)) {
    if (!name.startsWith('bare-') || EXEMPT.has(name)) continue

    const major = majorOf(range)
    if (major === null) continue

    if (!asked.has(name)) asked.set(name, new Map())
    const byMajor = asked.get(name)
    if (!byMajor.has(major)) byMajor.set(major, [])
    byMajor.get(major).push(`${where} (${range})`)
  }
}

const problems = []

for (const [name, byMajor] of asked) {
  if (byMajor.size < 2) continue

  const spread = [...byMajor]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([major, who]) => `      v${major}: ${who.join(', ')}`)
    .join('\n')

  problems.push(`  ${name} is asked for at ${byMajor.size} different majors:\n${spread}`)
}

if (problems.length > 0) {
  console.error('Bare runtime modules disagree across the workspace:\n')
  for (const problem of problems) console.error(problem)
  console.error(
    '\nBring them onto one major. A nested copy is a second implementation of\n' +
      'the same thing running in the same process, and for bare-tls that means\n' +
      'a second answer to whether a certificate is checked.'
  )
  process.exit(1)
}

console.log(`${asked.size} bare-* modules, each asked for at one major`)
