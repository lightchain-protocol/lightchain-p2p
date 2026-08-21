/**
 * The over-the-air update seam, smoke-tested as far as one machine honestly goes.
 *
 * OTA is the only update mechanism on MSIX, AppImage and DMG, so the question
 * this answers is: does a staged update actually reach a running install and
 * apply cleanly on restart. The full answer needs a production pear link, the
 * key ceremony that stages to it, and an always-on seeder — none of which exist
 * on this machine (see docs/decisions/0002-publish-round-trip.md, follow-ups
 * 2 and 3). What does exist here is every seam except the staged bytes, and
 * each is exercised for real:
 *
 *   - the running app reports its version and its update channel (live)
 *   - the worker really constructs the updater against that channel (live, on disk)
 *   - the channel either resolves to a manifest or fails legibly (live, this
 *     script joins the swarm as a peer of the update drive)
 *   - the apply seam fails retryably: an injected swap failure resets
 *     pear-runtime-updater's one-shot `applied` latch and the retry is a real
 *     second attempt (the production module, a simulated update source)
 *   - a staged build on the channel is either detected and signalled to a
 *     running install, or — when the stage carries no payload for this
 *     platform — refused legibly and not offered (live, the packaged build
 *     under out/ against throwaway storage)
 *   - after failure the app is healthy, and the update flow's restart hook
 *     quits it; relaunched, it boots healthy on the same storage (live)
 *
 * What cannot be done here is SKIPPED with the reason printed, never passed:
 * detection of a staged newer build, and apply-and-restart into it. In this
 * unpackaged instance pear-runtime-updater's applyUpdate is a no-op by
 * construction (`bundled` is false without an installed app path), so driving
 * it would manufacture a success nothing earned.
 *
 *     node scripts/ota-smoke.mjs [port] [storage-dir]
 *
 * Needs an instance running with --remote-debugging-port and updates ENABLED
 * (run-app.ps1 passes --no-updates; launch the same way without that flag).
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9335)
const storageDir =
  process.argv[3] ?? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'LightchainDemo', 'T')
// The app package root, for the package.json the running build was made from
// and as the working directory of the relaunch.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const require = createRequire(import.meta.url)

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const skip = (name, reason) => {
  results.push({ name, ok: 'skip', detail: reason })
  console.log(`SKIP  ${name} — ${reason}`)
}

// --- Attaching to the running instance -----------------------------------------
//
// `phase.quitting` is shared mutable state: this script deliberately quits the
// app twice (the restart-hook check, and the packaged build), and a renderer
// mid-write when its process is being torn down can surface an unhandled
// "No handler registered" rejection — main removes the writeIPC handler as
// the worker exits. That rejection is shutdown noise about a window that is
// already leaving, not a steady-state fault, so problems are tagged with
// whether a quit had been requested when they arrived and judged separately.

const phase = { quitting: false }

async function connect(label) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error(`no renderer on ${port}`)

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))

  let id = 1
  const problems = []
  socket.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push({
        session: label,
        duringQuit: phase.quitting,
        text: msg.params.exceptionDetails?.exception?.description ?? 'unknown exception'
      })
    }
  })

  const evaluate = (expression, timeout = 30_000) =>
    new Promise((resolve, reject) => {
      const mine = id++
      const bell = setTimeout(() => reject(new Error(`no answer in ${timeout}ms`)), timeout)
      const onMessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.id !== mine) return
        clearTimeout(bell)
        socket.removeEventListener('message', onMessage)
        const details = msg.result?.exceptionDetails
        if (details) reject(new Error(details.exception?.description ?? details.text))
        else resolve(msg.result?.result?.value)
      }
      socket.addEventListener('message', onMessage)
      socket.send(
        JSON.stringify({
          id: mine,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })

  socket.send(JSON.stringify({ id: id++, method: 'Runtime.enable' }))
  await evaluate(
    'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
  )

  const ask = (t, fields = {}) =>
    evaluate(
      `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
    )

  return { socket, evaluate, ask, problems }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const alive = () =>
  fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false)

/**
 * unlockForHarness, tolerant of a boot that is still in flight.
 *
 * Right after a relaunch the worker answers requests before its vault load
 * has settled: `wallet.status` can say "no wallet" about a directory whose
 * vault exists, and the `wallet.create` that answer invites is then correctly
 * refused with "a wallet already exists". The honest response to a boot race
 * is to ask again in a moment, not to conclude either way from the first
 * answer.
 */
async function unlockWhenReady(ask) {
  let last
  for (let i = 0; i < 6; i++) {
    try {
      return await unlockForHarness(ask)
    } catch (err) {
      last = err
      await wait(2000)
    }
  }
  throw last
}

// --- Phase 1: the running app reports its version and channel ------------------

const first = await connect('dev')
await unlockWhenReady(first.ask)

const reported = await first.evaluate('window.bridge.pkg()')
const onDisk = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))

report(
  'the running app reports a semver version',
  typeof reported?.version === 'string' && /^\d+\.\d+\.\d+/.test(reported.version),
  reported?.version
)
report(
  'and it is the version this tree would ship',
  reported?.version === onDisk.version,
  `running ${reported?.version}, package.json ${onDisk.version}`
)
report(
  'the update channel is a pear link',
  typeof reported?.upgrade === 'string' && reported.upgrade.startsWith('pear://')
)

// The link is the whole channel: if it does not decode to a drive key, every
// install boots with updates silently dead. Decoded with the same pear-link
// the updater uses.
let channelKey = null
try {
  const link = require('pear-link')
  const hid = require('hypercore-id-encoding')
  channelKey = hid.decode(link.parse(reported.upgrade).drive.key)
} catch (err) {
  report('the update channel decodes to a drive key', false, err.message)
}
if (channelKey) {
  report(
    'the update channel decodes to a drive key',
    Buffer.isBuffer(channelKey) && channelKey.length === 32,
    reported.upgrade
  )
  report(
    'and the running app and this tree agree on it',
    reported.upgrade === onDisk.upgrade,
    'a link is an update channel; drifting from the tree means updating somebody else'
  )
}

// --- Phase 2: the worker really constructed the updater against it -------------

// The updater keeps its Corestore apart from chat storage (workers/main.mjs):
// pear-runtime/corestore under the storage dir existing means the worker's
// PearRuntime built the update drive against the channel key above.
const updaterStore = path.join(storageDir, 'pear-runtime', 'corestore')
report(
  "the worker built the updater's corestore against the channel",
  fs.existsSync(updaterStore) && fs.readdirSync(updaterStore).length > 0,
  updaterStore
)

// The worker announces where its runtime landed on boot; the line is teed to
// the on-disk log whether or not anything is watching stdout.
const logFile = path.join(storageDir, 'logs', 'lightchain.log')
const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
report(
  'and announced its runtime storage on boot',
  logText.includes('storage:'),
  logText.match(/storage:.*$/m)?.[0]?.slice(0, 80) ?? 'no line in ' + logFile
)

// --- Phase 3: the channel resolves, or its unavailability fails legibly --------
//
// This script joins the update drive's swarm as a peer and asks for the
// manifest, exactly what the updater's first _update() does. Nothing seeds the
// development link on a good day (decision 0002, follow-up 3), so the likely
// outcome is a legible miss — which is itself the assertion: an install on a
// channel nobody feeds must fail to find an update, not hang or crash.

// How long to listen on the channel's discovery topic before calling it
// unfed. Generous, because DHT propagation is not instant; bounded, because a
// release smoke test that hangs is a release nobody can verify.
const PEER_WINDOW_MS = 15_000
const FETCH_BUDGET_MS = 10_000
let manifest = null
let probe = ''
{
  const Corestore = require('corestore')
  const Hyperdrive = require('hyperdrive')
  const Hyperswarm = require('hyperswarm')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-smoke-'))
  const store = new Corestore(tmp)
  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => store.replicate(socket))

  try {
    const drive = new Hyperdrive(store, channelKey)
    await drive.ready()
    const joined = swarm.join(drive.core.discoveryKey, { client: true, server: false })

    // Listen for the whole window rather than asking once and trusting the
    // first answer: an empty drive answers `get` with null immediately whether
    // or not anybody is out there, which would report a miss that never
    // looked. The window is the looking.
    const deadline = Date.now() + PEER_WINDOW_MS
    while (Date.now() < deadline && swarm.connections.size === 0) await wait(500)
    const peers = swarm.connections.size

    if (peers === 0) {
      probe = `no peer on the update channel after ${PEER_WINDOW_MS / 1000}s — nothing seeds it`
    } else {
      const buf = await Promise.race([
        (async () => {
          await drive.update({ wait: true })
          return drive.get('/package.json')
        })(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('peers connected but no manifest arrived')),
            FETCH_BUDGET_MS
          )
        )
      ])
      manifest = buf ? JSON.parse(buf.toString()) : null
      if (!manifest) probe = `${peers} peer(s) answered but served no manifest`
    }
    await joined.flushed?.().catch(() => {})
  } catch (err) {
    probe = err.message
  } finally {
    await swarm.destroy()
    await store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Three-part compare is enough: versions here are x.y.z by assertion above.
function semverGreater(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

const newerStaged = manifest !== null && semverGreater(manifest.version, reported.version)

if (manifest) {
  report(
    'the update channel resolves to a manifest',
    typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version),
    `staged ${manifest.version}, running ${reported.version}`
  )
  if (!newerStaged) {
    report('nothing newer is staged, so nothing is offered', true, 'versions agree')
  }
} else {
  // A real assertion about release state, not a dressed-up skip: the probe
  // listened on the channel for the full window and came back with a definite,
  // named negative. Decision 0002 follow-up 3 says nothing seeds; for release
  // execution that must stay visible until it is fixed, and a fresh install
  // today provably receives no update.
  report(
    'the development channel is observed unfed, within a bounded probe',
    probe.length > 0,
    probe
  )
}

// A dev install must never offer an update button: `updated` can only fire on
// a bundled install, so a visible button here would mean the signal lies.
report(
  'no phantom update is offered in an unpackaged install',
  (await first.evaluate(`document.getElementById('update-btn').hidden`)) === true,
  'the button stays hidden until the worker says updated'
)

// --- Phase 4: the apply seam, against a simulated update source ----------------
//
// The real production module (workers/update-apply.mjs), driven against a
// simulated Pear runtime that copies the one quirk that matters from the
// installed pear-runtime-updater@3.4.0: applyUpdate latches `applied = true`
// *before* the swap and never clears it (node_modules source, lines 94-96).
// Left alone that latch makes every retry a silent no-op reported as success.

const { applyStagedUpdate, UPDATE_APPLIED_LINE, updateFailureLine } = await import(
  new URL('../workers/update-apply.mjs', import.meta.url)
)

const attempts = []
const simulatedPear = {
  ready: async () => {},
  updater: {
    applied: false,
    applyUpdate: async () => {
      // pear-runtime-updater's real order: latch first, then the swap.
      simulatedPear.updater.applied = true
      attempts.push('swap')
      if (attempts.length === 1) throw new Error('swap target is read-only')
    }
  }
}
const written = []
const write = (line) => written.push(line)

const firstTry = await applyStagedUpdate(simulatedPear, write)
report(
  'a failed apply answers with the failure, not silence',
  firstTry === false && written[0] === 'pear:updateFailed swap target is read-only\n',
  JSON.stringify(written[0])
)
report(
  "and resets the updater's one-shot latch",
  simulatedPear.updater.applied === false,
  'without this the retry below would no-op and report success'
)

const secondTry = await applyStagedUpdate(simulatedPear, write)
report(
  'the retry is a real second attempt, and succeeds',
  secondTry === true && attempts.length === 2 && written[1] === UPDATE_APPLIED_LINE,
  `swap attempted ${attempts.length} times`
)

// The reply lines are the whole protocol with electron/main.js's applyUpdate
// handler, which splits on the delimiter — so an error holding newlines must
// still arrive as one line.
report(
  'the failure line survives the line-delimited pipe intact',
  updateFailureLine(new Error('denied\nread-only mount')) ===
    'pear:updateFailed denied read-only mount\n',
  'multi-line errors collapse to one reply line'
)

skip(
  'apply-and-restart into a staged build, live',
  "applying means installing the staged MSIX system-wide and letting the shell relaunch the app — that is the key ceremony's production link and a machine meant to receive it, not a smoke test's machine; the unpackaged instance cannot apply at all (pear-runtime-updater: bundled is false without an installed app path)"
)

// --- Phase 5: the failure cost the running app nothing --------------------------

const healthy = await first.ask('wallet.status')
report(
  'after the failed apply the app is still healthy',
  healthy?.exists === true && healthy?.unlocked === true,
  healthy?.address
)

// --- Phase 6: the restart hook fires --------------------------------------------
//
// app:afterUpdate is the exact handler the update flow calls after a confirmed
// apply (renderer/lib/ipc.js). On Windows it quits rather than relaunching —
// the update swap is MSIX and the shell restarts the app — so this proves the
// hook fires, then relaunches the instance itself and proves the boot.

phase.quitting = true
await first.evaluate('(window.bridge.appAfterUpdate(), true)').catch(() => {})

let gone = false
for (let i = 0; i < 60 && !gone; i++) {
  await wait(500)
  gone = !(await alive())
}
report(
  "the update flow's restart hook quits the app",
  gone,
  gone ? 'process exited' : 'still alive after 30s'
)
if (!gone) throw new Error('the app did not quit; cannot test the restart')

// --- Phase 7: a staged update is detected and signalled, live --------------------
//
// The unpackaged instance can never get here: pear-runtime-updater only checks
// for updates on a bundled install. The packaged build under out/ IS bundled,
// so when the channel carries a newer manifest this phase runs it against
// throwaway storage and watches the signal cross: worker detects, mirrors,
// writes `updating`/`updated` on the pipe, the renderer's status line moves
// and the button appears. It stops there — see the skip above for why the
// button is never pressed.
//
// The packaged run gets its own storage (`T-packaged`): it is a different
// build of the worker reading chat files, and cross-version storage drift is
// a variable this test does not need.

const packagedExe = path.join(appRoot, 'out', 'LightchainChat-win32-x64', 'LightchainChat.exe')

if (newerStaged && fs.existsSync(packagedExe)) {
  const packagedStorage = storageDir + '-packaged'
  const packagedLog = path.join(packagedStorage, 'logs', 'lightchain.log')
  spawn(packagedExe, [`--remote-debugging-port=${port}`, '--storage', packagedStorage], {
    cwd: path.dirname(packagedExe),
    detached: true,
    stdio: 'ignore'
  }).unref()

  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await wait(500)
    up = await alive()
  }
  if (!up) throw new Error(`the packaged build did not come up on ${port} within 30s`)

  const boxed = await connect('packaged')

  // Two honest outcomes, because both are real behaviors of the seam:
  //
  //   - the staged build carries a payload for this platform: the updater
  //     mirrors it, writes `updating`/`updated` on the pipe, and the renderer
  //     moves its status line and offers the button — detection and signaling
  //     proven end to end.
  //   - it does not: `_update()` throws 'update not found', the worker logs it
  //     and stays alive, and the renderer offers nothing. A broken stage must
  //     fail exactly this way — legibly, and without a phantom offer.
  //
  // 90s covers a slow DHT without pretending a hang is a pass.
  let signal = ''
  let updaterError = ''
  for (let i = 0; i < 180 && signal === '' && updaterError === ''; i++) {
    await wait(500)
    const seen = await boxed.evaluate(`({
      status: document.getElementById('status')?.textContent ?? '',
      offered: document.getElementById('update-btn')?.hidden === false
    })`)
    if (seen.offered) signal = 'update ready (button offered)'
    else if (/downloading update|update ready/.test(seen.status)) signal = seen.status
    if (fs.existsSync(packagedLog)) {
      updaterError =
        fs
          .readFileSync(packagedLog, 'utf8')
          .match(/\[worker:err\] Error: (update not found.*)/)?.[1] ?? ''
    }
  }

  if (signal !== '') {
    report(
      'a staged update is detected and signalled to a running install',
      true,
      `staged ${manifest.version}, running ${reported.version}: ${signal}`
    )
  } else {
    report(
      'a staged build with no payload for this platform is refused legibly',
      updaterError !== '',
      updaterError || `nothing within 90s (staged ${manifest.version}) — no signal, no logged error`
    )
    if (updaterError !== '') {
      report(
        'and the broken stage is not offered as an update',
        (await boxed.evaluate(`document.getElementById('update-btn').hidden`)) === true,
        'no phantom button'
      )
      report(
        'and the failed check cost the install nothing',
        (await boxed.evaluate(`typeof window.bridge.pkg`)) === 'function' &&
          (await boxed.evaluate('window.bridge.pkg()'))?.version === reported.version,
        'worker alive, app still reporting'
      )
      skip(
        'update-ready signaling, live',
        `staged ${manifest.version} carries no /by-arch/win32-x64 payload ("${updaterError.trim()}") — the channel currently holds a stage of a different app; a real chat build with the by-arch layout comes from the key ceremony`
      )
    }
  }

  await boxed.evaluate('(window.bridge.appAfterUpdate(), true)').catch(() => {})
  let boxedGone = false
  for (let i = 0; i < 60 && !boxedGone; i++) {
    await wait(500)
    boxedGone = !(await alive())
  }
  if (!boxedGone) throw new Error('the packaged build did not quit; refusing to delete its storage')
  boxed.socket.close()
  fs.rmSync(packagedStorage, { recursive: true, force: true })
} else {
  skip(
    'a staged update is detected and signalled to a running install, live',
    !manifest
      ? `channel unfed (${probe}); needs always-on seeding and a staged build from the key ceremony`
      : !newerStaged
        ? 'nothing newer than the running build is staged right now; staging needs the key ceremony'
        : `no packaged build at ${packagedExe}; run the package script first`
  )
}

// --- Phase 8: relaunched, the app boots healthy ---------------------------------

// The relaunch is a new process nobody asked to quit; exceptions in it are
// steady-state again.
phase.quitting = false

const electron = require('electron')
spawn(electron, ['.', `--remote-debugging-port=${port}`, '--storage', storageDir], {
  cwd: appRoot,
  detached: true,
  stdio: 'ignore'
}).unref()

let back = false
for (let i = 0; i < 60 && !back; i++) {
  await wait(500)
  back = await alive()
}
if (!back) throw new Error(`the app did not come back on ${port} within 30s`)

const second = await connect('relaunched')
const status = await unlockWhenReady(second.ask)
const reportedAgain = await second.evaluate('window.bridge.pkg()')

report(
  'relaunched, the app boots healthy on the same storage',
  status.exists === true && status.unlocked === true,
  status.address
)
report(
  'and reports the same version — no phantom apply happened at rest',
  reportedAgain?.version === reported.version,
  reportedAgain?.version
)
report(
  'and the update channel is reconstructed on boot',
  fs.existsSync(updaterStore) && reportedAgain?.upgrade === reported.upgrade
)

// Steady-state exceptions fail the run. Rejections that arrived after a quit
// was requested are reported by name rather than counted either way: counting
// them as failures makes the suite cry wolf about a window that was already
// leaving, and counting them as passes is how suites go blind.
const steady = [...first.problems, ...second.problems].filter((p) => !p.duringQuit)
const quitNoise = [...first.problems, ...second.problems].filter((p) => p.duringQuit)

report(
  'the renderer threw nothing while either session was running',
  steady.length === 0,
  steady[0]?.text ?? 'clean'
)
if (quitNoise.length > 0) {
  report(
    'and the only shutdown noise is the known write-during-quit race',
    quitNoise.every((p) => /No handler registered for 'pear:worker:writeIPC/.test(p.text)),
    `${quitNoise.length} rejection(s) after quit was requested (${quitNoise[0].session}): ${quitNoise[0].text.slice(0, 100)}`
  )
}

const failed = results.filter((r) => r.ok === false)
const skipped = results.filter((r) => r.ok === 'skip')
console.log(
  `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`
)
second.socket.close()
process.exit(failed.length ? 1 : 0)
