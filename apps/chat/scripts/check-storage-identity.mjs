/**
 * The name every installation's data is filed under, pinned so it cannot move.
 *
 * `storageDir()` in electron/main.js puts everything an install remembers under
 * a directory named for the application — `~/Library/Application Support/
 * <productName>` on macOS, `%LOCALAPPDATA%\<productName>` on Windows,
 * `$XDG_CONFIG_HOME/<productName>` on Linux. The wallet's vault, the sealed room
 * registry, the corestore holding every message and the swarm key that other
 * peers know this install by are all inside it.
 *
 * So `productName` is not a display string. It is the address of somebody's
 * money and their history, and renaming it in a release points every existing
 * install at a fresh empty directory. Nothing errors. The old data sits on disk
 * untouched and unreachable, the app opens reporting no wallet, and the person
 * looking at it has no way to tell that from having been robbed — which is
 * exactly the state that sends somebody to their recovery phrase, or to
 * reinstalling over the top.
 *
 * An OTA update makes that worse than a fresh install would: it arrives without
 * anybody choosing it, so the first they know is an empty window.
 *
 *     node scripts/check-storage-identity.mjs
 *
 * This does not make a rename impossible, and should not — it makes it
 * deliberate. Changing the pin below is a change to where every existing user's
 * data lives, and it needs a migration that moves the old directory before the
 * new name is ever read.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))

/**
 * What every install in the wild already has its data filed under.
 *
 * Read from a shipped build, not chosen here. Do not update it to match a
 * change — the check exists to notice that change.
 */
const PINNED = 'LightchainChat'

const found = []

if (pkg.productName !== PINNED) {
  found.push(
    `productName is "${pkg.productName}", pinned at "${PINNED}".\n` +
      `  Every existing install keeps its wallet and rooms in a directory of the\n` +
      `  pinned name. Under the new one they open to an empty account with their\n` +
      `  data stranded beside it, and an update delivers that without being asked\n` +
      `  for. If the rename is intended, write the migration that moves the\n` +
      `  directory first, then change the pin in this file.`
  )
}

// `appName` falls back to `name` when productName is absent, so an accidental
// deletion moves the directory just as effectively as a rename does.
if (typeof pkg.productName !== 'string' || pkg.productName === '') {
  found.push('productName is missing, so the storage directory falls back to the package name')
}

if (found.length > 0) {
  console.log('the storage directory would move:\n')
  for (const problem of found) console.log(`  ${problem}\n`)
  process.exit(1)
}

console.log(`storage identity is "${PINNED}" — where every install keeps its wallet and rooms`)
