import { AbiError, encodeParameters, selector } from './abi.js'
import { concat, toBytes, toHex } from './hex.js'
import type { Rpc } from './rpc.js'

/**
 * Many reads in one round trip.
 *
 * A wallet showing thirty token balances across five chains makes a hundred and
 * fifty calls every time it refreshes. Sequentially that is minutes; in
 * parallel it is a hundred and fifty requests at a public endpoint that rate
 * limits by IP. Multicall3 turns each chain's share into one call, which is the
 * difference between a wallet that refreshes and one that gets throttled.
 *
 * `aggregate3` is the tolerant variant and the only one worth using here: a
 * single token that reverts — self-destructed, or never a token at all —
 * fails just its own entry instead of the whole batch. The strict variants
 * would let one bad address in a list hide every balance behind it.
 *
 * The encoder in `abi.ts` handles static types and `bytes`, but not the array
 * of structs this takes, so the call is built by hand below. That is the whole
 * reason this is its own file.
 */

export interface Call3 {
  readonly to: string
  readonly data: string
}

export interface Call3Result {
  readonly success: boolean
  /** Return data on success; revert data, often empty, on failure. */
  readonly data: string
}

const AGGREGATE3 = selector('aggregate3((address,bool,bytes)[])')
const WORD = 32

function word(value: bigint | number): Uint8Array {
  return encodeParameters(['uint256'], [BigInt(value)])
}

/**
 * `aggregate3((address,bool,bytes)[])` call data.
 *
 * The layout, since it is written out by hand: one word of offset to the array,
 * one word of length, then one word per entry pointing at that entry's struct,
 * then the structs. Each struct is target, `allowFailure`, an offset to its
 * call data, then the length-prefixed data padded to a word.
 */
export function aggregate3Call(calls: readonly Call3[]): string {
  const structs = calls.map((call) => {
    const data = toBytes(call.data)
    const padding = (WORD - (data.length % WORD)) % WORD

    return concat(
      encodeParameters(['address'], [call.to]),
      // Always true. The point of this function is that one bad token does not
      // hide the rest, and a strict batch would defeat it.
      word(1),
      // Three words of head sit before the data in every struct.
      word(3 * WORD),
      word(data.length),
      data,
      new Uint8Array(padding)
    )
  })

  // Each entry's offset is measured from the start of the array's contents,
  // which begins after the length word and the table of offsets.
  const table: Uint8Array[] = []
  let at = calls.length * WORD
  for (const struct of structs) {
    table.push(word(at))
    at += struct.length
  }

  return toHex(concat(AGGREGATE3, word(WORD), word(calls.length), ...table, ...structs))
}

export function decodeAggregate3(data: string): Call3Result[] {
  const bytes = toBytes(data)
  if (bytes.length < 64) throw new AbiError(`aggregate3 returned ${bytes.length} bytes`)

  const read = (at: number) => Number(BigInt(toHex(bytes.slice(at, at + WORD))))

  const base = read(0)
  const count = read(base)
  const out: Call3Result[] = []

  for (let i = 0; i < count; i++) {
    const start = base + WORD + read(base + WORD + i * WORD)
    const success = read(start) === 1
    const at = start + read(start + WORD)
    const length = read(at)

    out.push({ success, data: toHex(bytes.slice(at + WORD, at + WORD + length)) })
  }

  return out
}

/**
 * Runs a batch, or falls back to one call at a time.
 *
 * `multicall3` is null on chains that do not have it deployed — Lightchain
 * among them — and the fallback keeps every caller from having to know which
 * is which. It is slower and it is correct, which is the right way round.
 */
export async function aggregate(
  rpc: Rpc,
  multicall3: string | null,
  calls: readonly Call3[]
): Promise<Call3Result[]> {
  if (calls.length === 0) return []

  if (multicall3 === null) {
    return Promise.all(
      calls.map(async (call) => {
        try {
          return { success: true, data: await rpc.call(call) }
        } catch {
          // Matching what aggregate3 does with a reverting call, so a caller
          // reads one shape whichever path ran.
          return { success: false, data: '0x' }
        }
      })
    )
  }

  return decodeAggregate3(await rpc.call({ to: multicall3, data: aggregate3Call(calls) }))
}
