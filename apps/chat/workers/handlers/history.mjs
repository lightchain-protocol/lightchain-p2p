import fetch from 'bare-fetch'
import { TRANSFER_TOPIC, chainById, decodeUint256 } from '@lcai-p2p/chain'

/**
 * What an address has done, assembled from whatever each chain will admit to.
 *
 * There is no single answer to this and pretending otherwise would be the
 * mistake. Three sources, in descending order of completeness:
 *
 * 1. **Blockscout**, on Lightchain. A real indexer, no key, and it knows about
 *    native transfers — including ones this application did not make.
 * 2. **`eth_getLogs` on Transfer topics**, everywhere else. Complete for
 *    tokens, because ERC-20 emits an indexed event, and **blind to native
 *    transfers**, because moving the native coin runs no contract and emits
 *    nothing at all. No amount of cleverness recovers those from logs.
 * 3. **The local ledger**, which is whatever this application itself sent.
 *
 * Every reply says which of these it used and what that source cannot see. A
 * history screen that quietly omits incoming transfers is worse than one that
 * says it cannot show them: the first makes somebody think they were not paid.
 */

/** Blockscout's own cap is 500 requests per fifteen minutes, so this is polite. */
const PAGE = 50

/**
 * How far back to scan for token transfers when there is no indexer.
 *
 * Providers signal their limits four different ways — a block range error, a
 * result count error, an HTTP 400, and a silent timeout — so the scan starts
 * wide and halves on any of them rather than trying to know each one's rules.
 */
const SCAN_START = 100_000n
const SCAN_FLOOR = 2_000n

const topicFor = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`

export function historyHandlers(ctx) {
  const { wallet, poolFor } = ctx

  /**
   * Blockscout, for the one chain that has one.
   *
   * Deliberately not its `/api/eth-rpc` proxy, which silently truncates
   * `eth_getLogs` at a thousand results and mishandles positional topic
   * filters — a query for "transfers to me" came back with the answer to
   * "transfers from me". Neither failure raises anything. The REST API is
   * sound; the RPC shim is not.
   */
  async function fromBlockscout(chain, address) {
    const base = `${chain.explorerUrl}/api/v2/addresses/${address}`

    const answer = await fetch(`${base}/transactions?filter=to%20%7C%20from`, {
      headers: { accept: 'application/json' }
    }).catch(() => null)

    // The combined filter is rejected by some versions, so fall back to
    // everything rather than to nothing.
    const response = answer?.ok
      ? answer
      : await fetch(`${base}/transactions`, { headers: { accept: 'application/json' } })

    if (!response.ok) throw new Error(`the explorer answered ${response.status}`)

    const body = await response.json()
    const items = Array.isArray(body?.items) ? body.items : []

    return items.slice(0, PAGE).map((item) => ({
      hash: item.hash,
      at: Date.parse(item.timestamp) || null,
      from: item.from?.hash ?? null,
      to: item.to?.hash ?? null,
      value: String(item.value ?? '0'),
      symbol: chain.symbol,
      decimals: chain.decimals,
      direction: sameAddress(item.from?.hash, address) ? 'out' : 'in',
      status: item.status === 'ok' ? 'confirmed' : 'failed',
      method: item.method ?? null,
      block: item.block_number ?? null
    }))
  }

  /**
   * Token transfers from logs, for the chains with no indexer.
   *
   * Two queries — transfers to this address and transfers from it — because
   * both `from` and `to` are indexed on ERC-20's event and a node can answer
   * either from an index. Native movement is invisible here and the caller is
   * told so rather than left to notice.
   */
  async function fromLogs(chain, address, token) {
    const pool = poolFor(chain.id)
    const latest = await pool.blockNumber()
    const mine = topicFor(address)

    const found = []

    for (const topics of [
      [TRANSFER_TOPIC, mine, null],
      [TRANSFER_TOPIC, null, mine]
    ]) {
      let span = SCAN_START
      let to = latest

      // One window, widened back out on success. Scanning the whole chain is
      // not on offer at a public endpoint, so this looks at the recent past and
      // says so.
      while (to > 0n && span >= SCAN_FLOOR) {
        const from = to > span ? to - span : 0n

        try {
          const logs = await pool.send('eth_getLogs', [
            {
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
              ...(token ? { address: token.address } : {}),
              topics
            }
          ])

          for (const log of logs ?? []) found.push(log)
          if (from === 0n) break
          to = from - 1n
          break
        } catch {
          // Every provider signals "too much" differently. Halving is the one
          // response that works for all four shapes.
          span /= 2n
        }
      }
    }

    // A transfer from this address to itself matches both indexed-topic
    // queries and would otherwise be listed twice. Dedup is by the log's own
    // identity — transaction and index within it — with the topics and data
    // as the fallback for a node that omits logIndex, so two genuinely
    // different transfers sharing one transaction are both kept.
    const seen = new Set()
    const unique = found.filter((log) => {
      const key = `${log.transactionHash}:${
        log.logIndex ?? `${String(log.topics?.[1])}/${String(log.topics?.[2])}/${String(log.data)}`
      }`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return unique
      .map((log) => {
        const from = `0x${String(log.topics?.[1] ?? '').slice(26)}`
        const recipient = `0x${String(log.topics?.[2] ?? '').slice(26)}`
        const known = token ?? null

        return {
          hash: log.transactionHash,
          at: null,
          from,
          to: recipient,
          value: log.data && log.data !== '0x' ? decodeUint256(log.data).toString() : '0',
          symbol: known?.symbol ?? 'token',
          decimals: known?.decimals ?? 18,
          direction: sameAddress(from, address) ? 'out' : 'in',
          status: 'confirmed',
          method: 'transfer',
          block: log.blockNumber ? Number(BigInt(log.blockNumber)) : null
        }
      })
      .sort((a, b) => (b.block ?? 0) - (a.block ?? 0))
      .slice(0, PAGE)
  }

  return {
    /**
     * One asset's history, from the best source that chain has.
     *
     * The `covers` field is the honest part and the reason this handler exists
     * rather than a single call to an indexer: it says what was asked and what
     * that source is blind to, so a screen can print the caveat instead of
     * implying completeness.
     */
    'history.forAsset': async (req) => {
      const address = wallet.status().address
      if (!address) throw new Error('unlock the wallet to see its history')

      const chainId = Number(req?.chainId)
      const chain = chainById(chainId)
      if (!chain) throw new Error('this wallet does not know that chain')

      const token = req?.token ? { address: String(req.token), ...req } : null

      // Lightchain has a real indexer and no key requirement, so it gets the
      // complete answer including native transfers nobody here made.
      if (chainId === 9200 && !token) {
        try {
          return {
            source: 'explorer',
            entries: await fromBlockscout(chain, address),
            covers: 'Everything this address has done on Lightchain, from the explorer.',
            blindTo: null
          }
        } catch (err) {
          return {
            source: 'none',
            entries: [],
            covers: null,
            blindTo: `The Lightchain explorer could not be reached (${err.message}). Nothing is missing from your balance — only this list.`
          }
        }
      }

      try {
        return {
          source: 'logs',
          entries: await fromLogs(chain, address, token),
          covers: token
            ? `Recent ${token.symbol ?? 'token'} transfers on ${chain.name}, recovered from the chain's own event log.`
            : `Recent token transfers on ${chain.name}, recovered from the chain's own event log.`,
          // The sentence that keeps this honest. Native transfers emit no
          // event, so no amount of log scanning finds them, and somebody who
          // was paid in the native coin would otherwise think they were not.
          blindTo: `Transfers of ${chain.symbol} itself do not appear here. Moving a network's own coin runs no contract and leaves no event to find, so only an indexer can list them — and there is no keyless one for ${chain.name}. Your balance already includes them.`
        }
      } catch (err) {
        return {
          source: 'none',
          entries: [],
          covers: null,
          blindTo: `${chain.name} could not be asked for history (${err.message}).`
        }
      }
    }
  }
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}
