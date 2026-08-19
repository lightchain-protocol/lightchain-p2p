const { screen } = require('electron')
const fs = require('fs')
const path = require('path')

/**
 * Where the window opens, and where it was left.
 *
 * Nearly all of this is defence rather than intent. A saved rectangle is a
 * claim about a display that may since have been unplugged, rearranged or
 * rescaled, and a window restored onto one that is no longer there opens where
 * nobody can see it — which reads as the application failing to start, not as a
 * placement bug, so it does not get reported as one.
 *
 * Every failure falls back to the default placement in silence. Forgetting
 * where a window was is a small annoyance; not opening one is the whole
 * application.
 */

// `resize` and `move` arrive continuously while a window is dragged. Saving on
// each of them is a synchronous write to disk for every frame of the drag.
const SETTLE_MS = 400

// How much of the window has to land on a display before its saved position is
// worth keeping. Below this there is too little of the titlebar showing to drag
// the window back with, so recentring is the only thing that makes it reachable.
const REACHABLE = { width: 120, height: 38 }

// Bounds do not read back as the numbers they were set from. Chromium keeps
// them in device-independent pixels and Windows in physical ones, and on a
// fractionally scaled display — 150%, 165% — each conversion rounds outward: a
// window asked for at 1320 wide reads back as 1325, and feeding that to the
// next launch reads back as 1330. Measured on a 165% display, where every
// bounds API drifts and none of them round-trips, so the guard has to be here
// rather than in the choice of API. Left alone it is a window that grows a
// little every time it is opened, which nobody connects to the size being
// remembered. A difference this small is that rounding, not somebody resizing.
const DRIFT = 10

const isSize = (value) => Number.isFinite(value) && value > 0
const clamp = (value, low, high) => Math.max(low, Math.min(value, high))
const centre = (start, span, size) => start + Math.round((span - size) / 2)

function read(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isSize(saved.width) || !isSize(saved.height)) return null

    return {
      width: Math.round(saved.width),
      height: Math.round(saved.height),
      // Position is optional in a way size is not, so a file carrying a usable
      // size and a damaged position is still worth half of.
      point:
        Number.isFinite(saved.x) && Number.isFinite(saved.y)
          ? { x: Math.round(saved.x), y: Math.round(saved.y) }
          : null,
      maximised: saved.maximised === true
    }
  } catch {
    // Absent on a first run, and truncated after a crash part-way through a
    // write. Neither is worth a message: what follows is a correct window, just
    // not the remembered one.
    return null
  }
}

function write(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('could not record the window placement:', err.message)
  }
}

/** Whether enough of `bounds` to take hold of sits on some display's work area. */
function reachable(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const left = Math.max(bounds.x, workArea.x)
    const top = Math.max(bounds.y, workArea.y)
    const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width)
    const bottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height)

    return right - left >= REACHABLE.width && bottom - top >= REACHABLE.height
  })
}

function place(saved, fallback) {
  const wanted = { width: saved?.width ?? fallback.width, height: saved?.height ?? fallback.height }
  const point = saved?.point ?? null

  // Discarded rather than nudged back into view. The monitor a position named
  // may have been unplugged, or may have sat to the left of this one, and there
  // is no way to work out where the window should have been instead — whereas
  // the middle of the primary display is somewhere the user is certainly
  // looking.
  const keep = point !== null && reachable({ ...point, ...wanted })

  // Measured against the display the window would land on rather than the
  // primary one, so a window remembered on a second monitor is judged by that
  // monitor's work area and not by this one's.
  const { workArea } = keep
    ? screen.getDisplayMatching({ ...point, ...wanted })
    : screen.getPrimaryDisplay()

  // Clamped rather than trusted. The default is deliberately larger than a
  // 1366x768 laptop can show, and a window opened bigger than the work area
  // hangs its own composer below the bottom of the screen, where there is
  // nothing to scroll it back into view.
  const width = Math.min(wanted.width, workArea.width)
  const height = Math.min(wanted.height, workArea.height)

  const x = keep
    ? clamp(point.x, workArea.x, workArea.x + workArea.width - width)
    : centre(workArea.x, workArea.width, width)
  const y = keep
    ? clamp(point.y, workArea.y, workArea.y + workArea.height - height)
    : centre(workArea.y, workArea.height, height)

  return { x, y, width, height, maximised: saved?.maximised === true }
}

/**
 * The placement to open at: the remembered one where it is still usable, and
 * `fallback` centred on the primary display where it is not.
 *
 * Always returns a rectangle, and never throws. Working out where a window
 * should go is not worth failing to open one over, so the last resort leaves
 * out the position entirely and lets Electron decide.
 */
function restore(file, fallback) {
  try {
    return place(read(file), fallback)
  } catch (err) {
    console.error('could not work out where to put the window:', err.message)
    return { ...fallback, maximised: false }
  }
}

function unchanged(next, previous) {
  return (
    next.maximised === previous.maximised &&
    Math.abs(next.x - previous.x) <= DRIFT &&
    Math.abs(next.y - previous.y) <= DRIFT &&
    Math.abs(next.width - previous.width) <= DRIFT &&
    Math.abs(next.height - previous.height) <= DRIFT
  )
}

/**
 * Keeps `file` in step with the window, without writing on every pixel of a
 * drag and without rewriting a placement that only moved by rounding.
 *
 * `placement` is what the window was actually opened at, which is not always
 * what the file says: a position on a monitor that is no longer there was
 * recentred, and an oversized one was clamped. Comparing against what happened
 * rather than against what was read leaves the original on disk, so a window
 * comes back to the monitor it belongs on when that monitor is plugged in
 * again.
 */
function track(win, file, placement) {
  let recorded = placement
  let pending = null

  function save() {
    pending = null
    // A minimised window has no geometry worth keeping — Windows parks it far
    // off the bottom of every display — and saving that is how the next launch
    // finds a position it has to throw away and recentre.
    if (win.isDestroyed() || win.isMinimized()) return

    // The bounds the window would return to, not the ones it currently fills.
    // Saving the maximised rectangle loses the size the user chose, so
    // unmaximising after a restart would leave it still filling the screen.
    const { x, y, width, height } = win.getNormalBounds()
    const state = { x, y, width, height, maximised: win.isMaximized() }

    if (unchanged(state, recorded)) return

    recorded = state
    write(file, state)
  }

  function saveSoon() {
    if (pending !== null) clearTimeout(pending)
    pending = setTimeout(save, SETTLE_MS)
  }

  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)

  // Written out rather than deferred: closing the window is how most sessions
  // end, and the process is usually gone before a timer set a moment ago runs.
  win.on('close', () => {
    if (pending !== null) clearTimeout(pending)
    save()
  })
}

module.exports = { restore, track }
