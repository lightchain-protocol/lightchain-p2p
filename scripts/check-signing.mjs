// Says what a release build will and will not sign, before it builds anything —
// and, given built artifacts, proves that they are actually signed.
//
// Every signing step in this repository skips itself when its secret is absent,
// which is the right behaviour — the workflow is identical before and after
// certificates exist — and also the dangerous one: an unsigned artifact looks
// exactly like a signed one until somebody downloads it. This prints the truth
// at the top of the log, and at the bottom of it.
//
//   node scripts/check-signing.mjs                      report inputs, always exits 0
//   node scripts/check-signing.mjs --require            fail unless every input is present
//   node scripts/check-signing.mjs --require <path...>  fail unless every artifact is signed
//
// The third form is the release gate, and the only one that looks at outputs
// rather than inputs: a configured secret never proved the signature landed.
// It runs on the runner that produced the artifact and checks with that
// platform's own tooling — signtool on Windows, codesign and stapler on
// macOS. Paths may be literal files, directories (existence only; that is the
// Linux case, which has no signature scheme in this pipeline), or globs using
// `*` and `**`, expanded here so no shell quoting behaviour matters.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
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

const USAGE = `usage:
  node scripts/check-signing.mjs                      report signing inputs, always exits 0
  node scripts/check-signing.mjs --require            exit 1 unless every signing input is present
  node scripts/check-signing.mjs [--require] <path...>  verify each artifact's signature
                                                      (paths may be files, directories, or globs
                                                      with * and **; --require makes a failure
                                                      fatal, without it the verdict is a report)

verification, by the platform this runs on:
  Windows   signtool verify /pa — the signature must chain to a trusted root
  macOS     codesign --verify --strict, ad-hoc signatures rejected, and stapler
            validate for .app/.dmg (an unsigned DMG passes only if the .app
            inside it is signed and notarized)
  Linux     existence only — no signature scheme exists in this pipeline
`

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

const requireMode = args.includes('--require')
const patterns = args.filter((a) => !a.startsWith('--'))

if (patterns.length > 0) {
  process.exit(verifyArtifacts(patterns, requireMode) ? 0 : 1)
}

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

if (requireMode) {
  console.error('refusing to build a release that would be partly unsigned.')
  process.exit(1)
}

console.log('building anyway; artifacts will be unsigned where noted above.')

// ---------------------------------------------------------------------------
// Artifact verification — the release gate.
// ---------------------------------------------------------------------------

function run(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8' })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `               ${line}`)
    .join('\n')
}

// Minimal glob: `*` and `?` within a path segment, `**` for any depth.
// Expanded here rather than by the shell so the workflow can quote the
// pattern and behave identically on bash and pwsh.
function expandGlob(pattern) {
  const segments = pattern.split(/[\\/]/)
  const firstWild = segments.findIndex((s) => /[*?]/.test(s))
  if (firstWild === -1) return existsSync(pattern) ? [pattern] : []

  const base = firstWild === 0 ? '.' : segments.slice(0, firstWild).join(sep)
  if (!existsSync(base)) return []

  const segmentRe = (segment) =>
    new RegExp(
      '^' +
        segment
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/\\\\]*')
          .replace(/\?/g, '[^/\\\\]') +
        '$'
    )

  const matches = []
  const walk = (dir, rest) => {
    if (rest.length === 0) {
      matches.push(dir)
      return
    }
    const [head, ...tail] = rest
    if (head === '**') {
      walk(dir, tail) // `**` matching zero directories
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), rest)
      }
      return
    }
    const re = segmentRe(head)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (re.test(entry.name)) walk(join(dir, entry.name), tail)
    }
  }
  walk(base, segments.slice(firstWild))
  return matches
}

function findSigntool() {
  if (process.env.SIGNTOOL_PATH) return process.env.SIGNTOOL_PATH

  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin'
  ].filter(existsSync)

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const found = []

  for (const root of roots) {
    for (const version of readdirSync(root)) {
      const candidate = join(root, version, arch, 'signtool.exe')
      if (existsSync(candidate)) found.push({ version, path: candidate })
    }
  }

  if (found.length === 0) return null
  // Highest SDK version wins.
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  return found[0].path
}

function verifyWindows(file) {
  const signtool = findSigntool()
  if (!signtool) return { ok: false, detail: 'signtool.exe not found; nothing can be verified' }

  // /pa applies the Authenticode verification policy: the signature must be
  // well-formed AND chain to a trusted root. A self-signed test certificate
  // fails here on purpose — see docs/decisions/0003-windows-signing.md — the
  // release gate demands the chain a user's machine will trust.
  const result = run(signtool, ['verify', '/pa', file])
  return result.status === 0
    ? { ok: true, detail: 'Authenticode signature verifies against a trusted root' }
    : { ok: false, detail: `signtool refuses it:\n${indent(result.output)}` }
}

function isAdhoc(file) {
  return /Signature=adhoc/.test(run('codesign', ['-dvv', file]).output)
}

function verifyMacBundle(file) {
  const verify = run('codesign', ['--verify', '--deep', '--strict', file])
  if (verify.status !== 0) {
    return { ok: false, detail: `codesign refuses it:\n${indent(verify.output)}` }
  }
  // A well-formed ad-hoc signature passes --verify and means nothing off the
  // build machine, so it has to be rejected explicitly.
  if (isAdhoc(file)) {
    return { ok: false, detail: 'ad-hoc signature; Gatekeeper treats it as unsigned' }
  }
  // Bundles have somewhere to keep a notarization ticket, and anything that
  // leaves the build machine needs one.
  const staple = run('xcrun', ['stapler', 'validate', file])
  if (staple.status !== 0) {
    return { ok: false, detail: `signed but not notarized:\n${indent(staple.output)}` }
  }
  return { ok: true, detail: 'code signature verifies and a notarization ticket is stapled' }
}

function verifyMacBinary(file) {
  const verify = run('codesign', ['--verify', '--strict', file])
  if (verify.status !== 0) {
    return { ok: false, detail: `codesign refuses it:\n${indent(verify.output)}` }
  }
  if (isAdhoc(file)) {
    return { ok: false, detail: 'ad-hoc signature; Gatekeeper treats it as unsigned' }
  }
  // A lone executable has nowhere to keep a ticket — see
  // scripts/notarize-macos.mjs — so notarization is not checked here.
  return { ok: true, detail: 'code signature verifies (not ad-hoc)' }
}

function verifyMacImage(file) {
  // A signed disk image stands on its own.
  const verify = run('codesign', ['--verify', '--strict', file])
  if (verify.status === 0 && !isAdhoc(file)) {
    return { ok: true, detail: 'the disk image itself is signed' }
  }

  // An unsigned DMG is still a fine release when the application inside is
  // signed and notarized — that is what Gatekeeper evaluates on first launch.
  // Mount read-only and check the thing the user actually opens.
  const mountPoint = mkdtempSync(join(tmpdir(), 'check-signing-'))
  const attach = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, file])
  try {
    if (attach.status !== 0) {
      return { ok: false, detail: `unsigned, and it does not even mount:\n${indent(attach.output)}` }
    }
    const apps = readdirSync(mountPoint).filter((name) => name.endsWith('.app'))
    if (apps.length === 0) {
      return { ok: false, detail: 'unsigned disk image with no .app inside to hold a signature' }
    }
    const inner = verifyMacBundle(join(mountPoint, apps[0]))
    return inner.ok
      ? { ok: true, detail: `disk image unsigned, but ${apps[0]} inside is signed and notarized` }
      : { ok: false, detail: `disk image unsigned, and ${apps[0]} inside fails: ${inner.detail}` }
  } finally {
    run('hdiutil', ['detach', mountPoint, '-force'])
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

function verifyOne(file) {
  if (statSync(file).isDirectory() && !file.endsWith('.app')) {
    // Directories carry no signature; this is the Linux case, where the gate
    // checks the artifact exists and nothing more.
    return { ok: true, detail: 'exists (directories carry no signature)' }
  }

  switch (process.platform) {
    case 'win32':
      return verifyWindows(file)
    case 'darwin':
      if (file.endsWith('.app')) return verifyMacBundle(file)
      if (file.endsWith('.dmg')) return verifyMacImage(file)
      return verifyMacBinary(file)
    default:
      return {
        ok: true,
        detail: 'no signature scheme on Linux; integrity comes from the pear upgrade link'
      }
  }
}

function verifyArtifacts(patterns, required) {
  let failed = 0
  let checked = 0
  console.log('artifact signatures:\n')

  for (const pattern of patterns) {
    const found = expandGlob(pattern)
    if (found.length === 0) {
      failed += 1
      console.log(`   ✗  ${pattern}`)
      console.log('      no matching artifact — the package step produced nothing to sign')
      continue
    }
    for (const file of found) {
      checked += 1
      const { ok, detail } = verifyOne(file)
      if (!ok) failed += 1
      console.log(`  ${ok ? ' ✓ ' : ' ✗ '}  ${file}`)
      console.log(`      ${detail}`)
    }
  }

  console.log('')
  if (failed === 0) {
    console.log(`every artifact (${checked}) is signed.`)
    return true
  }

  console.log(`${failed} artifact(s) are unsigned or mis-signed.`)
  if (!required) {
    console.log('report only; pass --require to make this fatal.')
    return true
  }
  console.error('refusing to release an unsigned artifact.')
  return false
}
