import PearRuntime from 'pear-runtime'
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import FramedStream from 'framed-stream'
import goodbye from 'graceful-goodbye'
import path from 'bare-path'
import fs from 'bare-fs'
import b4a from 'b4a'
import { persistent } from 'bare-storage'
import { isBareKit } from 'which-runtime'
import { RoomHost } from '@lcai-p2p/room'

/**
 * The data plane.
 *
 * Everything touching peers, storage or cryptography lives here rather than in
 * the renderer, which is sandboxed and cannot load native addons at all. The
 * renderer sends intents and receives state; it never holds a Hypercore.
 *
 * The room logic itself is in `@lcai-p2p/room`, where it is tested against a
 * real second peer. What is left here is wiring: a storage layout, a registry
 * file, and a translation between JSON frames and method calls.
 *
 * ## The wire format
 *
 * `FramedStream` supplies the message boundaries the raw IPC pipe does not, and
 * every frame is UTF-8. Two protocols share the pipe:
 *
 * - **Updater control**, plain strings (`updating`, `updated`,
 *   `pear:applyUpdate`, `pear:updateApplied`). Owned by pear-runtime and
 *   matched exactly in `electron/main.js`; do not change them.
 * - **Chat**, one JSON object per frame, told apart by a leading `{`.
 *
 * Renderer to worker, each carrying an `id` the reply echoes:
 *
 *     { id, t: 'room.list' }
 *     { id, t: 'room.create' }
 *     { id, t: 'room.join',    key }
 *     { id, t: 'room.send',    room, text }
 *     { id, t: 'room.invite',  room, writerKey }
 *     { id, t: 'room.leave',   room }
 *
 * Worker to renderer:
 *
 *     { t: 'ready', rooms: [state...] }
 *     { t: 'ok',    id, value }
 *     { t: 'error', id, message }
 *     { t: 'room',  room: state }        pushed whenever a room changes
 *
 * No shared module defines this. The renderer is sandboxed and cannot import
 * from the workspace, so its client repeats these strings, and changing one
 * side alone breaks the app quietly.
 */

// Mobile has neither the executable path nor the worker entry in argv, so the
// caller's first argument sits at a different index there.
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

const config = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || persistent(),
  app: argv(5)
}

const pipe = new FramedStream(Bare.IPC)
const swarm = new Hyperswarm()

// The updater's storage is kept apart from chat storage. They have unrelated
// lifetimes: clearing a corrupt chat history should not discard the release
// history the application updates from.
const pearStore = new Corestore(path.join(config.dir, 'pear-runtime', 'corestore'))
const pear = new PearRuntime({ ...config, swarm, store: pearStore })

const chatDir = path.join(config.dir, 'chat')
const chatStore = new Corestore(path.join(chatDir, 'corestore'))
const registryFile = path.join(chatDir, 'rooms.json')

function send(message) {
  pipe.write(JSON.stringify(message))
}

/**
 * Which rooms to reopen, and as whom.
 *
 * The namespace matters as much as the key: it decides which writer core a room
 * comes back on, so losing this file costs the write access each room granted
 * this peer, not merely the list.
 */
const registry = {
  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((e) => e && typeof e.key === 'string' && typeof e.namespace === 'string')
    } catch {
      // Absent on first run. A damaged file should not stop the app starting:
      // it costs the room list, and the rooms are still on disk.
      return []
    }
  },
  write(records) {
    try {
      fs.mkdirSync(chatDir, { recursive: true })
      fs.writeFileSync(registryFile, JSON.stringify(records, null, 2))
    } catch (err) {
      console.error('could not record the room list:', err.message)
    }
  }
}

const rooms = await RoomHost.open({
  store: chatStore,
  swarm,
  registry,
  onChange: (room) => send({ t: 'room', room })
})

for (const { key, reason } of rooms.failed) {
  console.error(`could not reopen room ${key.slice(0, 8)}: ${reason}`)
}

async function handle(req) {
  switch (req.t) {
    // The window can be reloaded while the worker keeps running, and `ready` is
    // only pushed once at boot. Without a way to ask, a reloaded renderer shows
    // an empty room list over a worker that is still in every room.
    case 'room.list':
      return rooms.states()

    case 'room.create':
      return rooms.create()

    case 'room.join':
      if (typeof req.key !== 'string') throw new Error('join needs a room key')
      return rooms.join(req.key)

    case 'room.send':
      if (typeof req.text !== 'string' || req.text.trim() === '') {
        throw new Error('nothing to send')
      }
      return rooms.send(req.room, req.text)

    case 'room.invite':
      if (typeof req.writerKey !== 'string') throw new Error('invite needs a writer key')
      return rooms.invite(req.room, req.writerKey)

    case 'room.leave':
      return { left: await rooms.leave(req.room) }

    default:
      throw new Error(`unknown request: ${String(req.t)}`)
  }
}

pear.updater.on('error', console.error)
pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))

swarm.on('connection', (socket) => {
  // RoomHost attaches its own handler for rooms. Protomux multiplexes the
  // stream, so the updater's cores and each room's cores share one connection
  // as separate channels.
  if (config.updates !== false) pearStore.replicate(socket)
  console.log(`peer connected (${swarm.connections.size} total)`)
  socket.on('close', () => console.log(`peer left (${swarm.connections.size} total)`))
})

if (config.updates !== false) {
  swarm.join(pear.updater.drive.core.discoveryKey, { client: true, server: false })
}

pipe.on('data', async (data) => {
  const text = b4a.toString(data)

  if (text === 'pear:applyUpdate') {
    await pear.ready()
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
    return
  }

  let req
  try {
    req = JSON.parse(text)
  } catch {
    console.log(text)
    return
  }

  try {
    send({ t: 'ok', id: req.id, value: await handle(req) })
  } catch (err) {
    // A failed request must not take the worker with it. The window would be
    // left as a shell over a dead data plane, which looks like a frozen app.
    send({ t: 'error', id: req.id, message: err.message })
  }
})

goodbye(async () => {
  await rooms.close()
  await swarm.destroy()
  await pear.close()
  await chatStore.close()
  await pearStore.close()
})

console.log('storage:', pear.storage)

send({ t: 'ready', rooms: await rooms.states() })
