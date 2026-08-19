import { svg } from './dom.js'
import { bridge } from './ipc.js'

/**
 * A QR code, wherever one is wanted.
 *
 * Its own module because it shares nothing with the surfaces that use it — no
 * room state, no wallet state. It takes a string and an element and draws.
 *
 * Two callers now: a room invite and a receiving address. The invite is the
 * default holder because it came first and because passing an element for the
 * common case would be noise at every call site.
 */

const inviteFigure = () => document.getElementById('invite-qr')

export function clearQr(holder = inviteFigure()) {
  holder?.querySelector('svg')?.remove()
}

/**
 * Draws a QR code as SVG rectangles.
 *
 * One rect per run of dark modules rather than per module: an invite fills a
 * grid of around 60 squared, and six hundred elements render visibly slower
 * than the sixty or so that runs collapse into.
 *
 * The label matters for anyone using a screen reader, who otherwise meets an
 * unexplained image in the middle of a dialog. It defaults to the invite
 * wording for the same reason the holder does.
 */
export async function drawQr(
  text,
  holder = inviteFigure(),
  label = 'An invite to this room, as a QR code'
) {
  clearQr(holder)
  if (!holder) return

  const grid = await bridge.qr(text)
  if (!grid) return

  const { size, data } = grid
  const quiet = 2
  const span = size + quiet * 2

  const chart = svg('svg', {
    viewBox: `0 0 ${span} ${span}`,
    width: 168,
    height: 168,
    role: 'img'
  })
  const title = svg('title', {})
  title.textContent = label
  chart.append(title)
  chart.append(svg('rect', { class: 'qr-bg', x: 0, y: 0, width: span, height: span }))

  for (let y = 0; y < size; y++) {
    let run = 0
    for (let x = 0; x <= size; x++) {
      const dark = x < size && data[y * size + x] === 1
      if (dark) {
        run += 1
        continue
      }
      if (run > 0) {
        chart.append(
          svg('rect', { class: 'qr-fg', x: x - run + quiet, y: y + quiet, width: run, height: 1 })
        )
        run = 0
      }
    }
  }

  holder.prepend(chart)
}
