import { fromQuantity } from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'

/**
 * The wallet's transaction ledger, extracted from `handlers/wallet.mjs` so that
 * every handler which broadcasts — wallet, ai, swap, bridge — writes to the
 * one sealed document rather than each keeping a separate idea of what has been
 * sent.
 *
 * ## The contract other handlers code against
 *
 *     import { recordTransaction } from '../ledger.mjs'
 *
 *     const entry = await recordTransaction(ctx, rpc, txish)
 *
 * `ctx` is the worker context. Only `ctx.localState`, `ctx.wallet` and
 * `ctx.network()` are read. `ctx.rpc()` is deliberately NOT consulted for the
 * chain id: that answer has to come from the chain the transaction was actually
 * broadcast to, which is not necessarily the one the wallet is connected to.
 *
 * `rpc` is the Rpc client of the SENDING chain. Its `chainId()` answer is what
 * lands on the entry, and that entry is later reconciled only against a chain
 * with the same id — so a swap broadcast to Ethereum must be recorded with the
 * Ethereum client, never with `ctx.rpc()`. Getting this wrong writes a Lightchain
 * chain id onto an Ethereum hash, and the entry then sits pending forever
 * because no reconcile pass will ever ask the right node about it.
 *
 * `txish` is one object: the kind, everything a `SentTransaction` carries, and
 * the optional linkage. Quantities are bigints, exactly as `sendTransaction`
 * returns them.
 *
 *     {
 *       kind: 'send',                  // 'send' | 'fund' | 'withdraw' | 'cancel'
 *                                      // | whatever a new handler calls itself
 *       hash: '0x…',                   // the transaction hash
 *       to: '0x…',                     // recipient
 *       value: 0n,                     // wei moved, as a bigint
 *       data: '0x…',                   // call data, '0x' for none
 *       gas: 0n,                       // the limit it was signed with
 *       maxFeePerGas: 0n,              // both fee caps, as bigints
 *       maxPriorityFeePerGas: 0n,
 *       nonce: 0n,
 *       wait: (options?) => Promise,   // SentTransaction.wait — resolves with
 *                                      // the receipt once mined
 *       replaces: '0x…' | null,        // optional — the hash this one outbids
 *       fallbackChainId: 9200          // optional — recorded if rpc.chainId()
 *                                      // fails; without it the value from
 *                                      // NETWORKS[ctx.network()] is used
 *     }
 *
 * Resolves with the pending entry once it is written; the receipt is then
 * followed in the background. That ordering is the point of the function. The
 * transaction is already broadcast and cannot be recalled, so the record has to
 * exist before anything is awaited: a wait that times out, or an application
 * closed while it waits, must not be the difference between a transaction
 * existing and this wallet knowing that it does.
 */

/**
 * The name of this account's ledger in {@link SealedStore}.
 *
 * Document names are restricted to plain words, and this one is scoped to the
 * account by the store itself — two accounts of one phrase keep two ledgers
 * without either knowing about the other.
 */
const LEDGER = 'transactions'
const LEDGER_VERSION = 1

/**
 * How many settled entries to keep.
 *
 * Trimming loses history that genuinely cannot be recovered from anywhere, so
 * the bound is generous and pending entries are never dropped: an entry still
 * waiting is the one thing here that has to survive to be reconciled. A
 * hundred kilobytes or so of sealed document is resealed and rewritten on every
 * update, which is the reason there is a bound at all.
 */
const LEDGER_KEEP = 500

/**
 * How young a settled entry has to be before {@link reconcile} asks about it
 * again, in blocks: 64.
 *
 * A receipt is not finality. The block holding it can still be reorganised
 * away — this chain's mainnet halted outright on 11 August 2026 — and an
 * entry that said "confirmed" about a block the chain has since unpicked is
 * a phantom success in the one record this wallet keeps. So settled entries
 * inside this window are re-checked on every reconcile: a receipt that is
 * gone sends the entry back to pending, where the ordinary pending logic can
 * find it re-mined, still held, or genuinely dead.
 *
 * Sixty-four blocks is about six and a half minutes at Lightchain's
 * six-second block time, and about thirteen on Ethereum's twelve-second one.
 * That covers every reorg either chain has a plausible mechanism for — real
 * reorgs are a block or two, and the halt-and-restart case replays minutes,
 * not hours — while bounding the re-checks each history read pays for to the
 * entries a reorg could still reach. Older entries are trusted, because a
 * chain that reorganised days of history would have worse problems than this
 * ledger.
 *
 * A node that will not answer changes nothing: the entry stays as it stands,
 * because an unreachable chain is not evidence of a reorg.
 */
const REORG_WINDOW_BLOCKS = 64n

/**
 * A decimal string, the shape quantities take once they are in the document.
 *
 * Shared with `handlers/wallet.mjs`, whose replacement logic refuses an entry
 * it cannot read back exactly.
 */
export const isDecimal = (value) => typeof value === 'string' && /^[0-9]+$/.test(value)

/**
 * What this wallet has sent, written down locally because nothing else will.
 *
 * **This is not an account history and an interface must not present it as
 * one.** It holds the transactions *this application* made from *this account*
 * on *this machine*, and nothing else. A payment sent from MetaMask, from a
 * hardware wallet, from this same phrase on a second computer, or by anyone
 * else to this address, will never appear here. Restoring the phrase somewhere
 * new starts an empty ledger. A screen labelled "your transactions" over this
 * data is telling somebody their account did less than it did, which is worse
 * than showing nothing: the number they cannot see is the one they would have
 * wanted. Label it as this application's own activity, and point anyone who
 * needs the real thing at an explorer.
 *
 * The alternative was not available. There is no indexer for this chain, and a
 * native transfer emits no log, so `eth_getLogs` cannot find one — the only way
 * to recover an account's transfers from the chain itself is to walk every
 * block since genesis, which is not something a chat application is going to
 * do. What can be known locally is what this process broadcast, so that is what
 * is kept.
 *
 * Sealed under the account like everything else in `localState`, which has a
 * consequence worth stating: a locked wallet cannot read its own ledger, and
 * switching account switches ledgers.
 *
 * ## What an entry holds
 *
 * Enough to show a row, and enough to rebuild the `SentTransaction` that
 * {@link speedUp} and {@link cancel} need — `to`, `value`, `data`, `gas`,
 * `nonce` and both fee caps — because that object lives in the memory of the
 * process that sent it and a replacement assembled from anything less is a
 * different transaction wearing the same nonce.
 *
 *     hash, kind, status                'send' | 'fund' | 'withdraw' | 'cancel',
 *                                       and 'pending' | 'confirmed' | 'failed'
 *     from, to, value, data             what was signed
 *     gas, maxFeePerGas,                and what it was signed to cost
 *       maxPriorityFeePerGas, nonce
 *     chainId, network                  which chain it was signed for
 *     at, settledAt                     epoch milliseconds
 *     block, gasUsed,                   from the receipt, null until there is one
 *       effectiveGasPrice, fee
 *     replaces, replacedBy              the other half of a speed-up or a cancel
 *     detail                            why a failed entry failed, in words
 *
 * A speed-up keeps the kind of the transaction it replaces, because it is the
 * same payment bid higher. A cancel does not: it is a zero-value transfer to
 * oneself and calling it a send would be a lie about where the money went.
 *
 * One ledger per context, so that every handler calling
 * {@link recordTransaction} shares it rather than each keeping a separate idea
 * of what has been written.
 */
const ledgers = new WeakMap()

export function transactionLedger(ctx) {
  const held = ledgers.get(ctx)
  if (held) return held

  const made = createLedger(ctx)
  ledgers.set(ctx, made)
  return made
}

function createLedger(ctx) {
  /**
   * The entries, with anything that is not one discarded.
   *
   * The same shape of defence the room registry uses, and for a better reason
   * than paranoia: `localState` is a directory of documents that other handlers
   * write to as well, and a record with no hash cannot be shown, settled or
   * replaced. Dropping it here means one bad row costs a row rather than
   * throwing from underneath every reply that touches the ledger. A record that
   * is present but incomplete is left alone and refused later, by name, where
   * somebody can be told which field was missing.
   */
  const entries = () => {
    const document = ctx.localState.read(LEDGER, { version: LEDGER_VERSION, entries: [] })
    if (!Array.isArray(document?.entries)) return []
    return document.entries.filter((entry) => entry && typeof entry.hash === 'string')
  }

  /**
   * Read, change, write — and deliberately synchronous throughout.
   *
   * The sealed store's own reads and writes are synchronous, so a change
   * applied here cannot interleave with another one; nothing else gets a turn
   * in between. That is what makes it safe for the slow work — asking a node
   * for a chain id, or for a receipt — to happen outside this function and hand
   * in a change to apply afterwards, rather than holding a copy of the document
   * across an await and writing back over whatever arrived meanwhile.
   */
  const update = (change) => {
    const next = change(entries())
    if (!next) return false

    const written = ctx.localState.write(LEDGER, { version: LEDGER_VERSION, entries: trim(next) })
    if (!written) {
      // Only reachable if the wallet locked between broadcasting and writing.
      // Reported rather than thrown: the transaction is on the chain either
      // way, and the entry is a record of it rather than part of it.
      console.error('the wallet locked before its transaction record could be written')
    }
    return written
  }

  const settle = (hash, receipt) =>
    update((current) => {
      if (!current.some((entry) => entry.hash === hash)) return null
      return current.map((entry) => (entry.hash === hash ? settled(entry, receipt) : entry))
    })

  /**
   * Appends a pending entry for something already broadcast.
   *
   * The chain id is asked of the client that sent the transaction rather than
   * taken from `NETWORKS`, because it is the chain the transaction was actually
   * signed against — `sendTransaction` used this same answer moments ago — and
   * reconciliation compares the two. A node that disagrees with the table would
   * otherwise leave every entry permanently unrecognised. The explicit `rpc`
   * is what lets a handler record a transaction sent on a chain other than the
   * connected one: pass that chain's client and the entry carries that chain's
   * id.
   */
  const record = async (rpc, kind, sent, { replaces = null, fallbackChainId } = {}) => {
    const chainId = await rpc
      .chainId()
      .catch(() => fallbackChainId ?? NETWORKS[ctx.network()].chainId)

    const entry = {
      hash: sent.hash,
      kind,
      status: 'pending',
      from: ctx.wallet.status().address,
      to: sent.to,
      value: sent.value.toString(),
      data: sent.data,
      gas: sent.gas.toString(),
      maxFeePerGas: sent.maxFeePerGas.toString(),
      maxPriorityFeePerGas: sent.maxPriorityFeePerGas.toString(),
      nonce: sent.nonce.toString(),
      chainId,
      network: ctx.network(),
      at: Date.now(),
      settledAt: null,
      block: null,
      gasUsed: null,
      effectiveGasPrice: null,
      fee: null,
      detail: null,
      replaces,
      replacedBy: null
    }

    update((current) =>
      current
        // A hash appears once. Recording the same one twice would be a
        // duplicated row for a single transaction, which reads as a double
        // spend to the only person who cannot check.
        .filter((held) => held.hash !== entry.hash)
        .map((held) => (held.hash === replaces ? { ...held, replacedBy: entry.hash } : held))
        .concat(entry)
    )

    return entry
  }

  /**
   * Settles an entry in the background when its receipt turns up.
   *
   * Polls gently, because nothing is waiting on the answer: a settle that
   * arrives four seconds late costs nobody anything, while a second poller at
   * the foreground's pace would double the traffic on a hash somebody is
   * already watching. A wait that runs out of patience is not a failure and is
   * not reported as one — the entry stays pending and the next history read
   * reconciles it, which is the path that has to work regardless for anything
   * still in flight when the application was closed.
   */
  const follow = (sent) => {
    void sent
      .wait({ interval: 4_000, timeout: 600_000 })
      .then((receipt) => settle(sent.hash, receipt))
      .catch(() => {})
  }

  /**
   * Catches every pending entry up with the chain, and re-checks the settled
   * ones a reorg could still reach.
   *
   * A `wait` lives in the memory of the process that started it, so anything
   * still in flight when the application closed comes back marked pending and
   * would stay that way for good. Asking the chain about each pending entry
   * on every read is the answer to that.
   *
   * The second pass is the reorg answer. A settled entry younger than
   * {@link REORG_WINDOW_BLOCKS} is asked for its receipt again: if the
   * receipt is gone, the block it was settled from was reorganised away and
   * the entry goes back to pending rather than standing in history as a
   * success that never happened; if it re-mined in a different block, the
   * entry follows it there. A node that will not answer is not evidence of
   * anything, and leaves every entry exactly as it stands.
   *
   * The chain asked is the connected one, `ctx.rpc()`, and only entries whose
   * recorded chain id matches are queried — an entry made on another chain is
   * left for a reconcile pass that is talking to that chain.
   */
  const reconcile = async () => {
    const current = entries()
    const waiting = current.filter((entry) => entry.status === 'pending')
    // Settled and carrying a block — the only entries a reorg can reach. A
    // failure written from a spent nonce has no block and is already final.
    const young = current.filter((entry) => entry.status !== 'pending' && isDecimal(entry.block))
    if (waiting.length === 0 && young.length === 0) return current

    const rpc = ctx.rpc()

    let chainId
    try {
      chainId = await rpc.chainId()
    } catch {
      // No node to ask. Pending is then the truthful state rather than a stale
      // one, and settled stays settled: an unreachable chain is not a reorg.
      return current
    }

    // Only what was sent to the chain now being spoken to. One account keeps
    // one ledger across both networks — the store is scoped per identity, not
    // per chain — and asking mainnet about a testnet hash gets a confident
    // "never heard of it" that would be read below as a transaction which never
    // happened.
    const mine = waiting.filter((entry) => entry.chainId === chainId)
    const mineYoung = young.filter((entry) => entry.chainId === chainId)

    // The head is what "young" is measured against. Fetched only when there
    // is a settled entry to re-check, so the common path — everything either
    // pending or long settled — pays nothing for this.
    const head = mineYoung.length === 0 ? null : await rpc.blockNumber().catch(() => null)

    const recheck =
      head === null
        ? []
        : mineYoung.filter((entry) => head - BigInt(entry.block) < REORG_WINDOW_BLOCKS)

    if (mine.length === 0 && recheck.length === 0) return current

    // `Rpc.transactionCount` asks for the pending count, which includes the
    // very transactions being reconciled and so always sits above their nonces.
    // The mined count answers the question actually worth asking: whether this
    // nonce has already been spent by something else, which is the only way to
    // establish that a pending transaction can never now be mined.
    const address = ctx.wallet.status().address
    const spent =
      mine.length === 0
        ? null
        : await rpc
            .send('eth_getTransactionCount', [address, 'latest'])
            .then((count) => fromQuantity(count))
            .catch(() => null)

    const resolved = new Map()

    await Promise.all([
      ...mine.map(async (entry) => {
        try {
          const receipt = await rpc.transactionReceipt(entry.hash)
          if (receipt) {
            resolved.set(entry.hash, settled(entry, receipt))
            return
          }

          // Held in a mempool, or mined in the moment between these two calls.
          // Either way it resolves itself and there is nothing to write.
          if (await rpc.transactionByHash(entry.hash)) return

          // The node has never heard of it and the nonce is spent, so something
          // else took it: a replacement of ours, or this same account signing
          // somewhere else. Whichever it was, this transaction cannot now
          // happen, and that is a definite answer rather than a guess.
          if (spent !== null && isDecimal(entry.nonce) && BigInt(entry.nonce) < spent) {
            resolved.set(entry.hash, {
              ...entry,
              status: 'failed',
              settledAt: Date.now(),
              detail: entry.replacedBy
                ? `replaced by ${entry.replacedBy}, which took nonce ${entry.nonce}`
                : `nonce ${entry.nonce} was spent by another transaction, so this one can never be mined`
            })
          }

          // Otherwise the nonce is still free and the node has merely forgotten
          // the transaction. It stays pending, because it can still be
          // rebroadcast and mined — deciding it is dead is how a wallet tells
          // somebody a payment failed shortly before it arrives.
        } catch {
          // One transaction the node will not answer for should not stop the
          // others being caught up.
        }
      }),
      ...recheck.map(async (entry) => {
        try {
          const receipt = await rpc.transactionReceipt(entry.hash)

          if (!receipt) {
            // The receipt is gone: the block this was settled from was
            // reorganised away. Back to pending — not failed, because the
            // transaction may simply be waiting to be mined again, and the
            // pending logic above is exactly the judgement for which. The
            // settled fields go with the receipt, so a phantom block, gas
            // figure and fee do not stand in history while it waits.
            resolved.set(entry.hash, {
              ...entry,
              status: 'pending',
              settledAt: null,
              block: null,
              gasUsed: null,
              effectiveGasPrice: null,
              fee: null,
              detail: null
            })
            return
          }

          if (receipt.blockNumber.toString() !== entry.block) {
            // Re-mined in a different block: a reorg moved it rather than
            // dropping it. The entry follows to the new block rather than
            // round-tripping through pending over a move nobody need see.
            resolved.set(entry.hash, settled(entry, receipt))
          }
        } catch {
          // A node that answers some hashes and not others leaves this one
          // as it stands. Settled it stays, until a pass that can ask.
        }
      })
    ])

    if (resolved.size === 0) return current

    update((held) => held.map((entry) => resolved.get(entry.hash) ?? entry))
    return entries()
  }

  return { entries, record, settle, follow, reconcile }
}

/** An entry, given the receipt that ended its wait. */
function settled(entry, receipt) {
  return {
    ...entry,
    status: receipt.status ? 'confirmed' : 'failed',
    settledAt: Date.now(),
    block: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    // What it really cost, which is the only fee figure worth showing: the caps
    // above are what was offered, and the difference is refunded.
    fee: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    detail: receipt.status
      ? null
      : 'mined, and reverted. The gas was still spent; the transfer did not happen.'
  }
}

/**
 * Drops the oldest settled entries once there are too many.
 *
 * Pending ones are kept whatever the count, since they are the entries with
 * work left to do and the only ones the chain can still change.
 */
function trim(entries) {
  if (entries.length <= LEDGER_KEEP) return entries

  let toDrop = entries.length - LEDGER_KEEP
  return entries.filter((entry) => {
    if (toDrop === 0 || entry.status === 'pending') return true
    toDrop -= 1
    return false
  })
}

/**
 * Records an outgoing transaction in this wallet's ledger. The exact contract —
 * parameters, their types, and what is read from each — is the header comment
 * at the top of this file, which other handlers code against.
 */
export async function recordTransaction(ctx, rpc, txish) {
  const { kind, replaces = null, fallbackChainId, ...sent } = txish

  const ledger = transactionLedger(ctx)
  const entry = await ledger.record(rpc, kind, sent, { replaces, fallbackChainId })
  ledger.follow(sent)
  return entry
}
