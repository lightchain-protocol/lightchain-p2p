/**
 * Turning what somebody typed into what gets signed, and back.
 *
 * The shortest path in this application between a keystroke and money leaving,
 * and it is string arithmetic throughout. `0.1` of an eighteen-decimal token is
 * 10^17, which no double represents exactly, and a balance in wei loses digits
 * as a Number from about a hundredth of a token upwards — which is the range
 * people actually send.
 *
 * No DOM here on purpose. These are the functions worth testing without a
 * window, and keeping them apart is what makes that possible.
 */

/**
 * A base-unit amount as something readable.
 *
 * Trailing zeros go and the fraction is capped, because a balance shown to
 * eighteen places is one nobody can read at a glance. `places` can be raised to
 * the token's own precision where the exact figure is the point — filling a Max
 * field, or a tooltip somebody is comparing against an explorer.
 */
export function formatUnits(base, decimals, places = 6) {
  const value = BigInt(base)
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const rest = value % scale

  if (rest === 0n) return whole.toLocaleString('en-US')

  const fraction = rest.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, places)
  if (fraction === '') return whole.toLocaleString('en-US')

  return `${whole.toLocaleString('en-US')}.${fraction}`
}

/** Every digit, ungrouped. For a tooltip, where the point is exactness. */
export function exactUnits(base, decimals) {
  const value = BigInt(base)
  const scale = 10n ** BigInt(decimals)
  return `${value / scale}.${(value % scale).toString().padStart(decimals, '0')}`
}

/**
 * The whole amount, with nothing a number field would choke on.
 *
 * What the Max button puts in the input. {@link formatUnits} groups thousands,
 * which reads well and is not a number: filling the field with `1,234.5` gives
 * somebody an amount that {@link toBaseUnits} then refuses, on a control whose
 * entire job is to be correct. Trailing zeros go so that a round balance does
 * not arrive as eighteen decimal places of nothing.
 */
export function plainUnits(base, decimals) {
  const value = BigInt(base)
  const scale = 10n ** BigInt(decimals)
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')

  return fraction === '' ? `${value / scale}` : `${value / scale}.${fraction}`
}

/**
 * A typed amount as base units, or null if it is not one.
 *
 * More decimal places than the token has is refused rather than rounded.
 * Rounding it would change somebody's amount silently, and which way it went is
 * not theirs to find out afterwards.
 *
 * Grouping separators are refused too. "1,5" means one and a half in some
 * places and fifteen in others, and a wallet is the wrong place to guess.
 */
export function toBaseUnits(typed, decimals) {
  const text = String(typed ?? '').trim()
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null

  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return null

  return (
    BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction || '0').padEnd(decimals, '0'))
  )
}

/**
 * Wei as an LCAI amount, to four places, grouped.
 *
 * Four places because a shortfall is arithmetic between two balances, so it
 * arrives with all eighteen decimals attached, and "Short
 * 50000.500000420201387974 LCAI" is a number nobody can read about the one
 * figure on the page they have to act on.
 *
 * **Truncate first, then strip.** The setup pages each had a copy of this and
 * the copies performed the same two steps in opposite orders. Stripping the
 * trailing zeros from all eighteen digits before taking four leaves the zeros
 * that are interior to the four it keeps: 0.10005 came out as "0.1000" rather
 * than "0.1". The validator page had that version.
 */
export function lcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === '' ? grouped : `${grouped}.${fraction}`
}

/**
 * A long value with its middle taken out.
 *
 * Here rather than beside `short` in dom.js because that module reaches for
 * `document` as it loads, so nothing in it can be exercised without a window —
 * and this is pure string work that three modules were each doing their own
 * way. The widths are arguments because the things it shortens are not the
 * same length: an address is 42 characters and a validator's public key is 98,
 * and six-and-four on the latter hides the part somebody is checking.
 *
 * Anything already short enough comes back untouched, rather than gaining an
 * ellipsis that saves no space and only removes information.
 */
export function truncate(value, head = 10, tail = 6) {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}
