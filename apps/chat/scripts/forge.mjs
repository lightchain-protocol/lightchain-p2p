/**
 * Runs Electron Forge against a self-contained copy of this app.
 *
 *     node scripts/forge.mjs package
 *     node scripts/forge.mjs make
 *
 * Forge cannot package this app in place. Its dependency walker resolves every
 * declared dependency from the app directory downwards, and pnpm with
 * `node-linker=hoisted` puts them in the *workspace root* `node_modules` while
 * the workspace packages themselves are junctions into `packages/`. Walking
 * `@lcai-p2p/blind` from `apps/chat` therefore looks for `b4a` somewhere it has
 * never been, and packaging stops before it copies a file.
 *
 * `pnpm deploy` exists for this: it writes a directory where the app and every
 * dependency it transitively needs are real, nested, non-symlinked folders —
 * the layout Forge assumes. Building there and copying the artifacts back keeps
 * `out/` where the workflow and everyone's habits expect it.
 *
 * The `--legacy` flag is not optional. From pnpm 10, `deploy` refuses to run on
 * a workspace that has not opted into injected dependencies, and injecting them
 * would rebuild native modules per consumer for no benefit here.
 *
 * `make` on Windows additionally needs PowerShell 7 (`pwsh`) on PATH: the MSIX
 * maker shells out to it to mint a development certificate. The GitHub
 * `windows-latest` runner has it; a desktop with only Windows PowerShell 5.1
 * does not, and fails at the signing step with a bare ENOENT. `package` does
 * not need it.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const step = process.argv[2] ?? 'package'
if (step !== 'package' && step !== 'make') {
  console.error(`usage: forge.mjs [package|make], not ${JSON.stringify(step)}`)
  process.exit(1)
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = resolve(appDir, '..', '..')
// Outside `apps/` so pnpm does not read the copy back as a workspace package.
const stagingDir = join(rootDir, '.tmp', 'forge', 'chat')

// `pnpm` and `npx` are batch files on Windows, so they need a shell — and a
// shell re-splits the arguments, which breaks the moment the checkout lives
// somewhere like "C:\Users\me\PEAR Open Source". Quoting here rather than
// trusting the default is what makes a path with a space survive.
const onWindows = process.platform === 'win32'
const quoted = (arg) => (onWindows && /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

const run = (command, args, cwd) => {
  console.log(`\n> ${command} ${args.join(' ')}\n`)
  const { status } = spawnSync(command, onWindows ? args.map(quoted) : args, {
    cwd,
    stdio: 'inherit',
    shell: onWindows
  })
  if (status !== 0) process.exit(status ?? 1)
}

// The renderer's tokens are generated, and deploy copies what is on disk.
run('node', [join(appDir, 'scripts', 'build-tokens.mjs')], appDir)

rmSync(stagingDir, { recursive: true, force: true })
mkdirSync(dirname(stagingDir), { recursive: true })

// Dev dependencies included: Forge itself and the Electron binary are among
// them, and Forge prunes them out of the packaged application anyway.
run(
  'pnpm',
  ['--filter', '@lcai-p2p/chat', '--legacy', 'deploy', stagingDir, '--prod=false'],
  rootDir
)

run('npx', ['electron-forge', step], stagingDir)

// Back to where the workflow uploads from, and where `out/` has always been.
const produced = join(stagingDir, 'out')
if (!existsSync(produced)) {
  console.error(`\nforge ${step} produced no out/ directory in ${stagingDir}`)
  process.exit(1)
}

const destination = join(appDir, 'out')
rmSync(destination, { recursive: true, force: true })
cpSync(produced, destination, { recursive: true })

console.log(`\n${step} complete: ${destination}`)
