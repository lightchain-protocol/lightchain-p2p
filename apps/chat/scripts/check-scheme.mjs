/**
 * The deep link scheme, checked in every place that has to agree about it.
 *
 * `lightchain://` is written down four times, in four languages, for four
 * audiences: the running process tells the OS what it handles, macOS reads the
 * packaging config, Windows reads the MSIX manifest, and the worker parses the
 * links it hands out. Nothing makes them agree.
 *
 * They did not. Packaging registered `pkg.name` — `@lcai-p2p/chat`, which is
 * not a legal URL scheme — so an invite could never open the packaged macOS
 * application, and the Windows manifest declared no scheme at all. Neither
 * shows up in development, where the scheme is registered by a running Electron
 * against a path, and neither shows up in any test that does not know to look.
 *
 *     node scripts/check-scheme.mjs
 *
 * Cheap enough to run in CI, which is the point: this is a class of bug that is
 * invisible until somebody installs a release and clicks a link.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(join(appDir, ...parts), 'utf8')

const found = []
const fail = (what, detail) => found.push(`${what}: ${detail}`)

const first = (source, pattern, what) => {
  const match = pattern.exec(source)
  if (!match) {
    fail(what, 'no scheme found at all')
    return null
  }
  return match[1]
}

// What the running process registers with the OS.
const main = first(read('electron', 'main.js'), /^const protocol = '([^']+)'/m, 'electron/main.js')

// What macOS reads out of the packaged application.
const forge = first(read('forge.config.js'), /^const protocol = '([^']+)'/m, 'forge.config.js')

// What Windows reads out of an installed MSIX.
const manifest = first(
  read('build', 'AppxManifest.xml'),
  /<uap:Protocol Name="([^"]+)"/,
  'build/AppxManifest.xml'
)

// What the worker produces in the links it hands out.
const worker = first(
  read('workers', 'handlers', 'rooms.mjs'),
  /^const INVITE_SCHEME = '([^']+)'/m,
  'workers/handlers/rooms.mjs'
)

const declared = { main, forge, manifest, worker }
const values = Object.values(declared).filter((value) => value !== null)

// A scheme has to be something an OS will accept, which `@lcai-p2p/chat` is not.
for (const [where, value] of Object.entries(declared)) {
  if (value === null) continue
  if (!/^[a-z][a-z0-9+.-]*$/.test(value)) fail(where, `"${value}" is not a legal URL scheme`)
}

if (new Set(values).size > 1) {
  fail('all four', `they disagree — ${JSON.stringify(declared)}`)
}

if (found.length > 0) {
  console.log('the deep link scheme does not line up:\n')
  for (const problem of found) console.log(`  ${problem}`)
  process.exit(1)
}

console.log(`deep link scheme is "${values[0]}" in all four places`)
