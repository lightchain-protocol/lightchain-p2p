import { command, flag, rest, summary } from 'paparam'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import process from 'bare-process'
import os from 'bare-os'
import path from 'bare-path'
import { persistent } from 'bare-storage'
import { Seeder, normalizeKey } from '@lcai-p2p/seed'
import { BlindRegistry, Priority } from '@lcai-p2p/blind'
import pkg from './package.json'

/**
 * Holds release and model drives so they stay installable.
 *
 * Applications are client-only by default: they download updates and re-serve
 * nothing. Without something running this, a published release reaches nobody
 * once the machine that staged it goes offline.
 */

const appName = pkg.productName || pkg.name

const cmd = command(
  appName,
  summary(pkg.description),
  flag('--version|-v', 'Print the current version'),
  flag('--storage <dir>', 'Storage directory'),
  flag('--blind-peer <key>', 'Also register with this blind peer. Repeatable.'),
  flag('--interval <seconds>', 'Status interval, default 30'),
  // Declared last: rest captures everything remaining, including anything that
  // looks like a flag, so flags must be defined before it.
  rest('[keys...]', 'Drive keys or pear links to seed')
)

cmd.parse(Bare.argv.slice(path.basename(Bare.argv[0]).startsWith('bare') ? 2 : 1))
if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

const raw = cmd.rest ?? []
if (raw.length === 0) {
  console.error(`\nNothing to seed. Pass one or more drive keys or pear links.\n`)
  console.error(`  ${appName} pear://<key> [<key>...]\n`)
  Bare.exit(1)
}

let keys
try {
  keys = raw.map(normalizeKey)
} catch (err) {
  console.error(`\n${err.message}\n`)
  Bare.exit(1)
}

const storage = cmd.flags.storage || path.join(persistent(), appName)
const interval = (Number(cmd.flags.interval) || 30) * 1000

const store = new Corestore(storage)
await store.ready()

const swarm = new Hyperswarm()
swarm.on('connection', (socket) => store.replicate(socket))

const seeder = new Seeder({ store, swarm })

console.log(`${appName} v${pkg.version}`)
console.log(`storage: ${storage}`)
console.log('')

for (const key of keys) {
  await seeder.add({ key })
  console.log(`seeding ${key}`)
}

console.log('\nfetching content...')
try {
  await seeder.waitUntilComplete()
} catch (err) {
  // Partial is still worth serving; say so rather than exiting.
  console.error(`\n${err.message}`)
  console.error('Continuing with whatever is held. Status below will show what is complete.\n')
}

const blindKeys = [].concat(cmd.flags.blindPeer ?? [])
let registry = null

if (blindKeys.length > 0) {
  registry = new BlindRegistry({
    dht: swarm.dht,
    store,
    peers: blindKeys.map((key) => ({ key }))
  })

  for (const { metadata, blobs } of await seeder.cores()) {
    // Both cores. Registering only the metadata stores a file listing with no
    // files behind it.
    await registry.registerCore(metadata, { priority: Priority.High, announce: true })
    await registry.registerCore(blobs, { priority: Priority.High, announce: true })
  }
  console.log(`registered with ${blindKeys.length} blind peer(s)`)
}

report()
const timer = setInterval(report, interval)

function report() {
  const stamp = new Date().toISOString().slice(11, 19)
  const entries = seeder.entries()
  const complete = entries.filter((e) => e.complete).length
  console.log(
    `[${stamp}] ${complete}/${entries.length} complete, ${swarm.connections.size} peers connected`
  )
  for (const e of entries) {
    console.log(`           ${e.complete ? 'held' : 'partial'}  v${e.version}  ${e.label}`)
  }
}

async function shutdown(code) {
  clearInterval(timer)
  console.log('\nstopping')
  await registry?.close().catch(() => undefined)
  await seeder.close().catch(() => undefined)
  await swarm.destroy().catch(() => undefined)
  await store.close().catch(() => undefined)
  Bare.exit(code)
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

console.log('\nSeeding. Press Ctrl+C to stop.\n')
