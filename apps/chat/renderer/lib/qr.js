import { svg } from './dom.js'
import { bridge } from './ipc.js'

/**
 * The invite QR code.
 *
 * Its own module because it shares nothing with the rest of the room surface —
 * no selection, no composer, no room state. It takes a string and draws it.
 */

const figure = () => document.getElementById('invite-qr')

export function clearQr() {
  figure()?.querySelector('svg')?.remove()
}

/**
 * Draws a QR code as SVG rectangles.
 *
 * One rect per run of dark modules rather than per module: an invite fills a
 * grid of around 60 squared, and six hundred elements render visibly slower
 * than the sixty or so that runs collapse into.
 */
export async function drawQr(text) {
  clearQr()

  const holder = figure()
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
  title.textContent = 'An invite to this room, as a QR code'
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
