import { command, flag, summary, arg } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import pkg from './package.json'
import App from './app.js'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')

const cmd = command(
  appName,
  summary(pkg.description),
  arg(
    '[subcommand]',
    'doctor | status | pull | import-key | keygen | register | start | stop | logs'
  ),
  flag('--address <hex>', 'which keystore to use, when more than one exists'),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--ollama-port <port>', 'port Ollama listens on (default 11434)'),
  flag('--tail <lines>', 'lines of worker log to show (default 200)')
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))
if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

const subcommand = cmd.args.subcommand

if (subcommand === 'doctor') {
  const { doctor } = await import('./lib/doctor.mjs')
  const ready = await doctor({ ollamaPort: Number(cmd.flags.ollamaPort) || undefined })
  Bare.exit(ready ? 0 : 1)
}

const WORKER_COMMANDS = [
  'status',
  'pull',
  'stop',
  'logs',
  'import-key',
  'keygen',
  'register',
  'start'
]

if (WORKER_COMMANDS.includes(subcommand)) {
  const worker = await import('./lib/worker.mjs')

  let config
  try {
    config = worker.loadConfig()
  } catch (err) {
    // Configuration problems are the operator's to fix and deserve the message
    // rather than a stack trace.
    console.error(`\nConfiguration: ${err.message}\n`)
    Bare.exit(1)
  }

  const address = cmd.flags.address

  try {
    let ok
    switch (subcommand) {
      case 'status':
        ok = worker.status(config)
        break
      case 'pull':
        ok = worker.pull(config)
        break
      case 'stop':
        ok = worker.stop(config)
        break
      case 'logs':
        ok = worker.logs(config, Number(cmd.flags.tail) || 200)
        break
      case 'import-key': {
        // stdin only. A flag would put the key in process listings and an
        // environment variable would hand it to every child process.
        const key = await worker.readSecretFromStdin()
        if (!key) {
          console.error('\nNothing on stdin. Pipe the key in, so it never reaches argv:\n')
          console.error('  cat key.txt | lcai-supervisor import-key\n')
          Bare.exit(1)
        }
        ok = worker.importKey(config, key)
        break
      }
      case 'keygen':
        ok = worker.keygen(config)
        break
      case 'register':
        ok = worker.register(config, address)
        break
      case 'start':
        ok = await worker.start(config, address)
        break
    }
    Bare.exit(ok ? 0 : 1)
  } catch (err) {
    // Keystore selection and config errors carry messages written for operators.
    console.error(`\n${err.message}\n`)
    Bare.exit(1)
  }
}

const updates = cmd.flags.updates
const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
const dir = storage || path.join(os.tmpdir(), 'pear', appName)

console.log(`Updates: ${updates === false ? 'disabled' : 'enabled'}`)

const app = new App({
  dir,
  app: isDev ? null : os.execPath(),
  updates,
  version: pkg.version,
  upgrade: pkg.upgrade,
  name: isWindows ? appName + '.exe' : appName
})

app.on('message', (message) => console.log(message))
app.on('updating', () => console.log('[updater] getting new update'))
app.on('updating-delta', (delta) => console.log('[updater]', delta))
app.on('updated', () => console.log('[updater] update complete... applying'))
app.on('update-applied', () =>
  console.log('[updater] applied update, restart to run latest version')
)
app.on('error', (err) => console.error('[app:error]', err))

process.on('SIGHUP', () => app.exit(129))
process.on('SIGINT', () => app.exit(130))
process.on('SIGQUIT', () => app.exit(131))
process.on('SIGTERM', () => app.exit(143))

try {
  await app.ready()
  console.log('\nCLI ready. Press Ctrl+C to stop.\n')
} catch (err) {
  console.error('[app:error]', err)
  await app.close().finally(() => Bare.exit(1))
}
