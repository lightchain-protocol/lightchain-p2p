// Says what a release build will and will not sign, before it builds anything.
//
// Every signing step in this repository skips itself when its secret is absent,
// which is the right behaviour — the workflow is identical before and after
// certificates exist — and also the dangerous one: an unsigned artifact looks
// exactly like a signed one until somebody downloads it. This prints the truth
// at the top of the log instead.
//
//   node scripts/check-signing.mjs           report, always exits 0
//   node scripts/check-signing.mjs --require  fail unless everything is present

import process from 'process'

const REQUIREMENTS = [
  {
    platform: 'Windows',
    what: 'Authenticode signature on the supervisor and seeder binaries',
    // Either satisfies it. The thumbprint is the OV-certificate route; the hook
    // is what Azure Artifact Signing needs, because it signs through a dlib
    // rather than from a certificate store.
    any: ['WINDOWS_CERT_SHA1', 'WINDOWS_SIGN_HOOK'],
    consequence: 'binaries ship unsigned; SmartScreen warns on every download'
  },
  {
    platform: 'macOS',
    what: 'code signature on the app bundle',
    any: ['MAC_CODESIGN_IDENTITY'],
    consequence: 'the app is unsigned; Gatekeeper refuses to open it'
  },
  {
    platform: 'macOS',
    what: 'notarization of the standalone binaries',
    any: ['NOTARY_PROFILE', 'NOTARY_APPLE_ID'],
    consequence:
      'the supervisor is blocked on any Mac that did not build it, reported as damaged rather than unsigned'
  }
]

const present = (name) => {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== ''
}

let missing = 0
console.log('signing inputs:\n')

for (const requirement of REQUIREMENTS) {
  const satisfied = requirement.any.filter(present)
  const ok = satisfied.length > 0
  if (!ok) missing += 1

  console.log(`  ${ok ? 'yes' : ' no'}  ${requirement.platform.padEnd(8)} ${requirement.what}`)
  console.log(
    ok
      ? `           using ${satisfied.join(' and ')}`
      : `           unset: ${requirement.any.join(' or ')}`
  )
  if (!ok) console.log(`           so: ${requirement.consequence}`)
}

// The one that cannot be checked here, and matters more than any of them.
console.log('')
console.log('  not checkable from the environment:')
console.log('    the upgrade link in apps/chat/package.json must be a production link')
console.log('    under a multisig quorum. The committed one is a development link whose')
console.log('    secret sits on a single machine.')

if (missing === 0) {
  console.log('\neverything a signed release needs is present.')
  process.exit(0)
}

console.log(`\n${missing} of ${REQUIREMENTS.length} signing inputs are missing.`)

if (process.argv.includes('--require')) {
  console.error('refusing to build a release that would be partly unsigned.')
  process.exit(1)
}

console.log('building anyway; artifacts will be unsigned where noted above.')
