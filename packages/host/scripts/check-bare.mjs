/**
 * Runs the probes under Bare and fails if any of them cannot execute.
 *
 * The unit tests cover interpretation, not reachability, and every probe here
 * catches its own errors — which is right for a probe and terrible for
 * noticing that one of them is broken. A missing global throws a
 * ReferenceError, the catch turns it into "not reachable", and the result is a
 * confident false failure telling an operator to start something that is
 * already running. That is exactly what happened with `fetch`.
 *
 * So this checks the mechanism rather than the answer: the probe has to have
 * reached the host and come back with something. Run it under both runtimes:
 *
 *     pnpm check:bare
 */

import fetch from '#fetch'
import { probeAll } from '../dist/index.js'

const runtime = typeof Bare === 'undefined' ? 'node' : 'bare'
const problems = []

if (typeof fetch !== 'function') problems.push('fetch is not callable')

const probes = await probeAll()

// Docker, memory and disk answer on every supported host. A probe returning
// undefined means it threw, which is the failure this script exists to catch.
for (const name of ['docker', 'memory', 'disk']) {
  if (probes[name] === undefined) problems.push(`${name} probe did not run`)
}

if (probes.memory && !(probes.memory.totalBytes > 0)) {
  problems.push('memory probe returned a nonsense total')
}

console.log(`${runtime}: docker  ${JSON.stringify(probes.docker)}`)
console.log(`${runtime}: ollama  ${JSON.stringify(probes.ollama)}`)
console.log(`${runtime}: gpu     ${JSON.stringify(probes.gpu)}`)
console.log(`${runtime}: memory  ${JSON.stringify(probes.memory)}`)
console.log(`${runtime}: disk    ${JSON.stringify(probes.disk)}`)
console.log(`${runtime}: cast    ${JSON.stringify(probes.cast)}`)

if (problems.length > 0) {
  console.error(`\n${runtime}: FAIL`)
  for (const problem of problems) console.error(`  ${problem}`)
  if (runtime === 'bare') Bare.exit(1)
  else process.exit(1)
}

console.log(`\n${runtime}: every probe ran`)
