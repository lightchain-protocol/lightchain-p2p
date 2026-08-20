import { toast } from './dom.js'

/**
 * The coin ting, and the message beside it.
 *
 * A deposit is the one piece of news this application gets that nobody asked
 * for and everybody wants: money arrived. The worker watches the balances and
 * pushes `wallet.deposit`; this module is what that push becomes — a toast
 * naming the amount, and a short chime unless the setting says otherwise.
 *
 * The chime is synthesized, not a file: a binary asset would have to ship in
 * the build and be fetched over `file://`, and two oscillators are four lines
 * of WebAudio that work offline forever. Two partials a fourth apart — 1568 Hz
 * (G6) and 2093 Hz (C7), the pair a xylophone coin suggests — with a fast
 * attack and an exponential decay, the second partial quieter and shorter,
 * which is what reads as a "ting" rather than a beep.
 *
 * ## Autoplay
 *
 * A window that has never been touched is not allowed to make noise, and the
 * AudioContext starts `suspended` there. So the context is created lazily and
 * resumed on the first gesture; a deposit that lands before anyone has touched
 * the window gets its toast and no sound, which is the honest outcome — the
 * alternative, queueing the noise until the next click, would ring about money
 * that arrived an hour ago. Every failure is silent: a sound that cannot play
 * is never an error worth showing.
 */

let audio = null

/** Resumed on the first gesture, because before one it cannot start. */
for (const name of ['pointerdown', 'keydown']) {
  window.addEventListener(name, () => void audio?.resume().catch(() => {}), {
    passive: true
  })
}

function ting() {
  try {
    audio ??= new AudioContext()

    const strike = () => {
      const at = audio.currentTime
      for (const [frequency, gain, length] of [
        [1568, 0.18, 0.6],
        [2093, 0.1, 0.35]
      ]) {
        const oscillator = audio.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency

        const envelope = audio.createGain()
        envelope.gain.setValueAtTime(0, at)
        envelope.gain.linearRampToValueAtTime(gain, at + 0.008)
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + length)

        oscillator.connect(envelope).connect(audio.destination)
        oscillator.start(at)
        oscillator.stop(at + length)
      }
    }

    if (audio.state === 'running') {
      strike()
      return
    }

    // Suspended: either nobody has touched the window yet, or the resume
    // raced this call. Ask, play if the answer is yes, and give up quietly
    // if it is no.
    void audio
      .resume()
      .then(() => {
        if (audio.state === 'running') strike()
      })
      .catch(() => {})
  } catch {
    // No audio device, no permission, no support: the toast still said it.
  }
}

/**
 * Whether the chime is on. Set from the settings panel and at startup; the
 * toast is not gated by it — the message is the information, the sound is the
 * nudge.
 */
let soundOn = true

export function setDepositSound(on) {
  soundOn = on === true
}

/**
 * What a `wallet.deposit` push becomes on screen.
 *
 * The amount arrives pre-formatted from the worker (`amountText`), because the
 * renderer must not do money arithmetic it does not have to: one formatting
 * implementation, in `workers/guard.mjs`, is how the toast and the
 * confirmation dialogs keep agreeing.
 */
export function notifyDeposit(msg) {
  const amount =
    typeof msg?.amountText === 'string' && msg.amountText !== ''
      ? msg.amountText
      : `${msg?.symbol ?? 'funds'}`
  const where = typeof msg?.chainName === 'string' && msg.chainName !== '' ? ` on ${msg.chainName}` : ''

  toast(`Received ${amount}${where}`)
  if (soundOn) ting()
}
