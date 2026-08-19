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
