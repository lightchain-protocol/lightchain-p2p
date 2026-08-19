/**
 * Fails when two applications share a Pear upgrade link.
 *
 * A link is an update channel, not a name. Whatever is staged to it becomes
 * what every install of that link receives, so two apps carrying the same one
 * are one app as far as updates are concerned: staging the chat client pushes
 * the chat client to supervisor installs, and the next supervisor release
 * pushes it back.
 *
 * Nothing catches this. Both apps build, both boot, both stage, and the damage
 * only appears on a machine that installed one and received the other. It
 * happened here — both apps were generated from the same `pear touch` and
 * carried one link between them for as long as anybody had been looking.
 *
 *     node scripts/check-links.mjs
 *
 * An app with no `upgrade` field is skipped rather than failed: not every
 * package in this repository is one that ships.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apps = path.join(root, 'apps')

const seen = new Map()
const problems = []

for (const name of fs.readdirSync(apps)) {
  const manifest = path.join(apps, name, 'package.json')
  if (!fs.existsSync(manifest)) continue

  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const link = pkg.upgrade
  if (typeof link !== 'string' || link === '') continue

  if (!/^pear:\/\/[a-z0-9]{52}$/.test(link)) {
    problems.push(`apps/${name}: "${link}" is not a pear:// link with a 52-character z32 key`)
    continue
  }

  const already = seen.get(link)
  if (already) problems.push(`apps/${name} and apps/${already} share the upgrade link ${link}`)
  else seen.set(link, name)
}

if (problems.length > 0) {
  console.error('Upgrade links are not distinct:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('\nGenerate one per app with `pear touch`.')
  process.exit(1)
}

console.log(`${seen.size} app${seen.size === 1 ? '' : 's'}, each with its own upgrade link`)
