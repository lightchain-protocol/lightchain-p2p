#!/usr/bin/env node
/**
 * Builds a Bare application to a standalone native binary.
 *
 *   node scripts/make.mjs <app> [host]
 *   node scripts/make.mjs supervisor            # current host
 *   node scripts/make.mjs supervisor win32-x64  # explicit target
 *
 * Runs bare-build from the WORKSPACE ROOT, not from the app directory. That is
 * not a stylistic choice: bare-build resolves modules against a base directory
 * that defaults to the working directory, and in a monorepo the dependencies
 * live in the root node_modules. Building from the app directory produces a
 * binary that compiles cleanly and then dies on startup with
 * MODULE_NOT_FOUND for file:///C:/node_modules/bare-worker/lib/worker-thread.js,
 * because the traverse escaped the base and rooted the bundle at the filesystem
 * root.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const HOSTS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
])

const [appArg, hostArg] = process.argv.slice(2)

if (!appArg) {
  console.error('usage: node scripts/make.mjs <app> [host]')
  process.exit(1)
}

const host = hostArg ?? `${os.platform()}-${os.arch()}`
if (!HOSTS.has(host)) {
  console.error(`unsupported host: ${host}`)
  console.error(`supported: ${[...HOSTS].join(', ')}`)
  process.exit(1)
}

const appDir = path.join(ROOT, 'apps', appArg)
const manifestPath = path.join(appDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`no app at apps/${appArg}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const name = manifest.productName ?? manifest.name.replace(/^@[^/]+\//, '')
const entry = path.relative(ROOT, path.join(appDir, manifest.bin ?? 'bin.mjs'))
const out = path.relative(ROOT, path.join(appDir, 'out', host))

console.log(`building ${name} for ${host}`)

const res = spawnSync(
  'pnpm',
  ['exec', 'bare-build', '--name', name, '--standalone', '--host', host, '--out', out, entry],
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }
)

if (res.error) {
  console.error(res.error.message)
  process.exit(1)
}
process.exit(res.status ?? 1)
