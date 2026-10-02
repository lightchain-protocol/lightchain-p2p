/**
 * Builds the Windows installer on any machine - including a Mac - for free.
 *
 *     pnpm make:windows        (from apps/chat)
 *
 * Two steps. Forge packages the app for win32-x64: every native module in it
 * ships a ready-made Windows binary, and the exe's icon and version are set in
 * JavaScript, so nothing needs compiling for Windows. Then electron-builder
 * wraps that folder in an NSIS installer (build/electron-builder.windows.json):
 * per-user, no administrator rights, Start-menu and desktop shortcuts, an
 * uninstaller.
 *
 * On an Apple Silicon Mac, NSIS's compiler is an Intel binary and needs
 * Rosetta 2 once: `softwareupdate --install-rosetta --agree-to-license`.
 *
 * Writes out/make/windows/LightchainChat-Setup-<version>.exe and a portable
 * zip beside it.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const onWindows = process.platform === 'win32'

const run = (command, args, cwd = appDir) => {
  console.log(`\n> ${command} ${args.join(' ')}\n`)
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit', shell: onWindows })
  if (status !== 0) process.exit(status ?? 1)
}

run('node', [join(appDir, 'scripts', 'forge.mjs'), 'package', '--platform=win32', '--arch=x64'])

const packaged = join(appDir, 'out', 'LightchainChat-win32-x64')
const output = join(appDir, 'out', 'make', 'windows')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

// electron-builder downloads nothing for Electron here (the app is already
// packaged) but still wants the exact version, and package.json holds a range.
const electronVersion = require('electron/package.json').version

run('npx', [
  '--yes',
  'electron-builder@26.15.3',
  '--win',
  'nsis',
  '--x64',
  '--prepackaged',
  packaged,
  '--publish',
  'never',
  `-c.electronVersion=${electronVersion}`,
  `-c.directories.output=${output}`,
  '--config',
  join(appDir, 'build', 'electron-builder.windows.json')
])

const version = require(join(appDir, 'package.json')).version
const zip = join(output, `LightchainChat-win32-x64-${version}.zip`)
if (onWindows) run('tar', ['-a', '-cf', zip, '.'], packaged)
else run('zip', ['-qry', zip, '.'], packaged)

console.log(`\nWindows installer: ${output}`)
