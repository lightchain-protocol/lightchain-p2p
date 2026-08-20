/**
 * Searching what a model said, across the wiring rather than the logic.
 *
 * The search itself — substring matching, ordering, the limit, and a deleted
 * conversation staying deleted — is unit tested in `packages/inference`, over a
 * log that can be filled without paying for anything. What cannot be tested
 * there is everything this checks: that the handler is reachable, that a locked
 * wallet degrades to searching rooms instead of failing whole, and that adding
 * a second source did not break the surface that renders them together.
 *
 * Nothing here seeds a transcript. Doing so would mean a worker handler that
 * writes arbitrary turns into the history log, which is a capability the
 * application does not otherwise have and should not gain for a test.
 *
 *     node scripts/transcript-search.mjs [port]
 */

import { ASK, HARNESS_PASSWORD, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9480)

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error(`no renderer on ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let id = 1
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
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

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)
await unlockForHarness(ask)

// --- Something for the room half to find ---------------------------------------

// Without this the combined surface is only ever exercised on its empty path,
// which is the one case where a mistake in the grouping cannot show.
const NEEDLE = `zaphod${Date.now().toString(36)}`

const rooms = await ask('room.list')
const room =
  rooms?.rooms?.[0]?.key ?? (await ask('room.create', { name: 'transcript search' }))?.key

if (room) await ask('room.send', { room, text: `a message about ${NEEDLE} to find` })

report('there is a room message to search for', Boolean(room), room ? NEEDLE : 'no room')

// --- The handler ---------------------------------------------------------------

const empty = await ask('ai.search', { query: '   ' })
report(
  'a query of only spaces is refused rather than matching every turn',
  Boolean(empty?.error),
  empty?.error ?? `returned ${empty?.results?.length} results`
)

const miss = await ask('ai.search', { query: `nothing-called-this-${Date.now()}` })
report(
  'a query that matches nothing returns an empty list, not an error',
  Array.isArray(miss?.results) && miss.results.length === 0,
  miss?.error ?? 'empty'
)

// An unlocked wallet with no history is the ordinary case on a fresh instance,
// and it has to be distinguishable from a failure.
report(
  'searching an empty history is a result rather than a fault',
  !miss?.error && Array.isArray(miss?.results),
  'well-formed'
)

// --- The two logs stay apart ---------------------------------------------------

// Rooms are readable with the wallet locked; transcripts are encrypted under a
// key only an unlocked wallet derives. The surface has to degrade to the half
// it can read rather than showing nothing.
await ask('wallet.lock')

const lockedRooms = await ask('room.search', { query: NEEDLE })
report(
  'a locked wallet still searches rooms',
  !lockedRooms?.error && (lockedRooms?.results?.length ?? 0) > 0,
  lockedRooms?.error ?? `${lockedRooms?.results?.length ?? 0} matches`
)

const lockedTranscripts = await ask('ai.search', { query: NEEDLE })
report(
  'and a locked transcript log refuses rather than returning someone else nothing',
  Boolean(lockedTranscripts?.error) || (lockedTranscripts?.results?.length ?? 0) === 0,
  lockedTranscripts?.error ?? 'empty'
)

await ask('wallet.unlock', { password: HARNESS_PASSWORD })

// --- The surface that renders both ---------------------------------------------

// `show()` gained a second argument and `summarise()` a third. Both are called
// only from a keystroke, so a mistake in either is invisible until somebody
// searches — which is exactly the sort of thing that ships.
const surface = await evaluate(`(async () => {
  // Closed first, then opened. The shortcut is a toggle, so dispatching it
  // against a surface a previous run left open closes it instead — and what
  // follows then reads the last query's note and the last query's rows and
  // reports them as this query's. That passes, which is worse than failing.
  document.getElementById('search-dialog')?.close()
  await new Promise((r) => setTimeout(r, 50))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))

  const dialog = document.getElementById('search-dialog')
  const input = document.getElementById('search-input')
  if (!dialog || !input) return { missing: true }
  if (!dialog.open) return { missing: true, shut: true }

  const noteNow = () => document.querySelector('.search-status')?.textContent ?? ''

  // Opening runs the empty query first, which writes its own note. Waiting for
  // "a note that is not Searching…" therefore succeeds instantly against that
  // one, before a single character has been typed — so what is waited for is a
  // note that differs from the one already there.
  const before = noteNow()

  input.value = ${JSON.stringify(NEEDLE)}
  input.dispatchEvent(new Event('input', { bubbles: true }))

  // Polled rather than slept through. The old fixed 900ms was two worker round
  // trips on the machine it was written on; a slower one reads the surface
  // mid-search and reports the interim 'Searching…' as the outcome.
  const deadline = Date.now() + 15000
  let waited = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    waited += 100
    const note = noteNow()
    if (note !== '' && note !== before && note !== 'Searching\\u2026') break
  }

  const note = noteNow()
  const rendered = document.querySelectorAll('.search-result').length
  const groups = [...document.querySelectorAll('.search-group-name')].map((n) => n.textContent)

  document.getElementById('search-dialog')?.close()
  return { open: dialog.open === true || dialog.hasAttribute('open'), note, rendered, groups, waited }
})()`)

report(
  'the search dialog opens on the shortcut',
  surface?.missing !== true,
  surface?.shut
    ? 'the shortcut did not open it'
    : surface?.missing
      ? 'no dialog in the document'
      : `present, answered in ${surface.waited}ms`
)

report(
  'a search runs and reports its outcome in one line',
  typeof surface?.note === 'string' && surface.note !== '' && surface.note !== 'Searching…',
  JSON.stringify(surface?.note)
)

// The room half returning results while the transcript half returns none is the
// ordinary case, and the one where a mistake in combining them would show.
report(
  'a room match renders when the transcript half is empty',
  surface?.rendered >= 1,
  `${surface?.rendered} rows`
)

// The exact wording matters less than that it is one of the states the surface
// actually has, rather than a template with an undefined in it.
report(
  'and that line is a sentence rather than a hole where a count should be',
  typeof surface?.note === 'string' &&
    !/undefined|NaN|\[object/.test(surface.note) &&
    /match|Nothing/.test(surface.note),
  surface?.note
)

report(
  'transcript results are grouped under their own heading when there are any',
  Array.isArray(surface?.groups) &&
    (surface.groups.length === 0 || surface.groups.every((g) => typeof g === 'string' && g !== '')),
  (surface?.groups ?? []).join(' | ') || 'no groups, nothing matched'
)

console.log('')
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed} passed, ${failed} failed`)
socket.close()
process.exit(failed === 0 ? 0 : 1)
