// Notarizes and staples a macOS binary or bundle.
//
// `bare-build` signs and cannot notarize, so without this Gatekeeper blocks the
// supervisor on every Mac that did not build it — with a dialog that says the
// file is damaged, which is not what is wrong and sends people looking in the
// wrong place.
//
// Electron Forge notarizes the app bundle itself through `osxNotarize`. This is
// for the standalone Bare binaries, which nothing else covers.
//
//   node scripts/notarize-macos.mjs apps/supervisor/out/darwin-arm64/lcai-supervisor
//
// Credentials come from the environment, one of two ways:
//
//   NOTARY_PROFILE           a keychain profile made by `notarytool store-credentials`
//   or
//   NOTARY_APPLE_ID          the Apple ID
//   NOTARY_PASSWORD          an app-specific password, not the account password
//   NOTARY_TEAM_ID           the ten-character team identifier

import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import process from 'process'

const target = process.argv[2]

if (!target) {
  console.error('usage: node scripts/notarize-macos.mjs <path to signed binary or .app>')
  process.exit(64)
}

if (os.platform() !== 'darwin') {
  // Not a failure. The build matrix runs this step on every host and only one
  // of them can do anything with it.
  console.log(`notarize: skipped, ${os.platform()} cannot notarize`)
  process.exit(0)
}

if (!fs.existsSync(target)) {
  console.error(`notarize: ${target} does not exist`)
  process.exit(1)
}

const credentials = process.env.NOTARY_PROFILE
  ? ['--keychain-profile', process.env.NOTARY_PROFILE]
  : process.env.NOTARY_APPLE_ID && process.env.NOTARY_PASSWORD && process.env.NOTARY_TEAM_ID
    ? [
        '--apple-id',
        process.env.NOTARY_APPLE_ID,
        '--password',
        process.env.NOTARY_PASSWORD,
        '--team-id',
        process.env.NOTARY_TEAM_ID
      ]
    : null

if (!credentials) {
  console.log('notarize: skipped, no credentials in the environment')
  process.exit(0)
}

const run = (command, args, opts = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...opts })
  if (result.error) throw result.error
  return result.status ?? 1
}

// Notarization takes a zip or a disk image, never a bare executable, so a
// single binary is wrapped for the trip.
const isBundle = target.endsWith('.app')
const archive = isBundle ? `${target}.zip` : path.join(os.tmpdir(), `${path.basename(target)}.zip`)

console.log(`notarize: packing ${target}`)
if (run('ditto', ['-c', '-k', '--keepParent', target, archive]) !== 0) {
  console.error('notarize: could not pack the target')
  process.exit(1)
}

console.log('notarize: submitting, which can take several minutes')
const submitted = run('xcrun', [
  'notarytool',
  'submit',
  archive,
  ...credentials,
  '--wait',
  // Without this a rejection is a bare id and a suggestion to go and look it
  // up, which in CI means the log is gone by the time anyone reads it.
  '--output-format',
  'plist'
])

fs.rmSync(archive, { force: true })

if (submitted !== 0) {
  console.error('notarize: Apple rejected the submission')
  process.exit(1)
}

// Stapling attaches the ticket to the artifact, so it opens on a machine that
// is offline or behind a firewall that blocks Apple's OCSP responder.
//
// A lone executable has nowhere to attach a ticket — only bundles and disk
// images do — so this is skipped rather than failed. Such a binary is still
// notarized; it just needs the network the first time it runs.
if (isBundle) {
  console.log('notarize: stapling the ticket')
  if (run('xcrun', ['stapler', 'staple', target]) !== 0) {
    console.error('notarize: could not staple the ticket')
    process.exit(1)
  }
  run('xcrun', ['stapler', 'validate', target])
} else {
  console.log('notarize: not stapling — a plain executable has nowhere to keep a ticket')
}

console.log(`notarize: done, ${target}`)
