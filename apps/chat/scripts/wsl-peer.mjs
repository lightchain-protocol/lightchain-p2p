/**
 * A room peer with no interface, to be a second machine.
 *
 * ## Why this exists
 *
 * `drive-two-instances.mjs` runs both sides, but both sides are processes on
 * one computer: one kernel, one network stack, one clock, and traffic that
 * never leaves the loopback interface. Everything it proves is real, and none
 * of it touches the code path that matters most — two peers finding each other
 * across a network and holding a connection open.
 *
 * Run inside WSL, this is that second peer. WSL2 has its own kernel, its own
 * network namespace and its own NAT between it and the Windows host, so a
 * connection from here to the application really is negotiated rather than
 * short-circuited. That is a harder path than two laptops on one home network,
 * where both sit behind the same router.
 *
 * It needs no display, no Electron and no wallet. The application's
 * peer-to-peer half lives entirely in the worker; the window is a view over it.
 * So a second machine is a Corestore, a swarm and a RoomHost, which is all this
 * is.
 *
 * ## Running it
 *
 *     # once, to build the workspace inside WSL
 *     wsl -d Ubuntu -e bash scripts/wsl-setup.sh
 *
 *     # then, from the application, make an invite and hand it over
 *     wsl -d Ubuntu -e bash -lc "cd ~/lc/lightchain-p2p/apps/chat && \
 *       node scripts/wsl-peer.mjs say '<invite>' 'hello from Linux'"
 *
 * The invite may be the `lightchain://` link or the bare string; both are
 * accepted, the same way the application accepts both.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { RoomHost } from '@lcai-p2p/room'

const [mode, invite, ...rest] = process.argv.slice(2)

if (mode !== 'join' && mode !== 'say') {
  console.error('usage: wsl-peer.mjs <join|say> <invite> [text]')
  process.exit(1)
}
if (!invite) {
  console.error('an invite is required. Make one in the application: Invite someone.')
  process.exit(1)
}

const at = () => new Date().toISOString().slice(11, 19)
const log = (...args) => console.log(at(), ...args)

// Fresh storage every run. A peer that reuses a Corestore is a peer that
// already knows the room, which is the opposite of what this is for.
const dir = mkdtempSync(join(tmpdir(), 'lcai-peer-'))
const store = new Corestore(dir)
await store.ready()

const swarm = new Hyperswarm()
swarm.on('connection', (socket) => store.replicate(socket))

log(`storage ${dir}`)

const rooms = await RoomHost.open({
  store,
  swarm,
  onChange: (room) => {
    const said = room.messages.filter((m) => !m.event).length
    log(`room changed: ${said} message(s), ${room.messages.length - said} event(s)`)
  },
  onPresence: (key, state) => log(`presence: ${state.peers} peer(s), ${state.typing} typing`)
})

const bare = invite
  .trim()
  .replace(/^lightchain:\/\//i, '')
  .split(/[/?#\s]/)[0]

log('pairing')
const started = Date.now()

let state
try {
  state = await rooms.pair(bare)
} catch (err) {
  log(`pairing failed after ${Date.now() - started}ms: ${err.message}`)
  log(`this peer had ${[...swarm.connections].length} swarm connection(s) at the time`)
  process.exit(1)
}

log(`paired in ${Date.now() - started}ms`)
log(`room     ${state.key}`)
log(`name     ${state.name ?? '(unnamed)'}`)
log(`writable ${state.writable}`)
log(`history  ${state.messages.length} entr(ies)`)
for (const m of state.messages) log(`  ${m.event ? '·' : '>'} ${m.text}`)

if (mode === 'say') {
  const text = rest.join(' ') || `hello from a second machine at ${new Date().toISOString()}`
  await rooms.send(state.key, text)
  log(`sent: ${text}`)
}

log('staying online, so the other side can reply. Ctrl-C to stop.')

const timer = setInterval(() => {
  const p = rooms.presenceOf(state.key)
  log(`holding: ${p.peers} peer(s), ${p.typing} typing`)
}, 15_000)
timer.unref?.()
