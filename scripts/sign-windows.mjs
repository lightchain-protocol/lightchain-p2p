import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Authenticode-signs Windows binaries.
 *
 * Takes the certificate as a SHA-1 thumbprint in `WINDOWS_CERT_SHA1`, which is
 * the same input name `holepunchto/actions/make-pear-app` uses. That is
 * deliberate: swapping a test certificate for a real one is then a change of
 * value, not a change of pipeline.
 *
 *   WINDOWS_CERT_SHA1=<thumbprint> node scripts/sign-windows.mjs <file...>
 *
 * A self-signed certificate works here and produces a signature nobody else
 * will trust, which is the point — it proves the path end to end before the
 * real certificate exists, when a broken hook is cheap to fix.
 */

// RFC 3161. Required, not optional: without a timestamp the signature stops
// verifying the moment the certificate expires, and code signing certificates
// are short-lived.
const TIMESTAMP_URL = 'http://timestamp.digicert.com'

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

function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('usage: WINDOWS_CERT_SHA1=<thumbprint> node scripts/sign-windows.mjs <file...>')
    process.exit(1)
  }

  if (process.platform !== 'win32') {
    console.error('Authenticode signing runs on Windows. Skipping.')
    process.exit(1)
  }

  const thumbprint = process.env.WINDOWS_CERT_SHA1
  if (!thumbprint) {
    console.error(
      'WINDOWS_CERT_SHA1 is not set. Nothing identifies which certificate to sign with.'
    )
    process.exit(1)
  }

  const signtool = findSigntool()
  if (!signtool) {
    console.error('signtool.exe not found. Install the Windows SDK, or set SIGNTOOL_PATH.')
    process.exit(1)
  }

  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      console.error(`no such file: ${file}`)
      process.exit(1)
    }

    console.log(`signing ${file}`)
    try {
      execFileSync(
        signtool,
        ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', TIMESTAMP_URL, '/td', 'SHA256', file],
        { stdio: 'inherit' }
      )
    } catch {
      console.error(`\nsigning failed for ${file}`)
      process.exit(1)
    }
  }

  console.log(`\nsigned ${files.length} file(s)`)
}

main()
