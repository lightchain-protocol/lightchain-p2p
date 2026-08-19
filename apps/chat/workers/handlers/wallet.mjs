import {
  FEE_PER_GAS_CEILING,
  cancel,
  fromPrivateKey,
  fromQuantity,
  prepaidBalance,
  resolveAddresses,
  sendTransaction,
  speedUp
} from '@lcai-p2p/chain'
import { derivePrivateKey } from '@lcai-p2p/wallet'
import { NETWORKS } from '@lcai-p2p/worker'

/**
 * The wallet: an identity, a balance, and the ability to sign for both.
 *
 * `wallet.status` is the only request here that returns without doing work. The
 * rest run scrypt at roughly half a second, which is the cost that makes a
 * stolen keystore expensive to attack rather than a delay to apologise for.
 *
 * Every reply carries the network. It is not decoration: an address means
 * something different on each chain, and a renderer that showed a balance
 * without saying which one would be showing a number nobody can act on.
 *
 * ## Quantities cross this seam as decimal strings
 *
 * Said once, because it applies to every reply below. Wei, gas, fees and nonces
 * are bigints on this side and JSON has no bigint at all: `JSON.stringify`
 * throws on one outright, and converting to a `Number` first loses precision
 * above 2^53 — which in wei is a hundredth of a token, so the rounding lands
 * exactly where somebody is looking at a balance. Every such value is therefore
 * `.toString()` on the way out and parsed back from a string on the way in.
 * What stays a number in these replies is only what is genuinely small and
 * counted: an account index, a chain id, a millisecond timestamp.
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
 * How many accounts of a phrase are worth listing.
 *
 * Twenty, because that is BIP-44's gap limit: a phrase restored in another
 * wallet is searched by walking forward from zero until twenty unused accounts
 * go by. Anything past that is an address no other wallet will ever show its
 * owner again, so offering it here would be offering somewhere to strand money.
 */
const MAX_ACCOUNTS = 20
const DEFAULT_ACCOUNTS = 5

const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
const isHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
const isCallData = (value) => typeof value === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(value)
const isDecimal = (value) => typeof value === 'string' && /^[0-9]+$/.test(value)

/**
 * A quantity the renderer sent, as a bigint, or nothing.
 *
 * `BigInt('twelve')` throws a SyntaxError naming a type nobody outside this
 * process has heard of. Everything a caller can get wrong is worth one sentence
 * that says which field and what it wanted instead.
 */
function whole(value, field) {
  if (value === undefined || value === null || value === '') return undefined

  let amount
  try {
    amount = BigInt(value)
  } catch {
    throw new Error(
      `${field} must be a whole number written as a decimal string, and ${JSON.stringify(value)} is not one`
    )
  }

  if (amount < 0n) throw new Error(`${field} cannot be negative, got ${amount}`)
  return amount
}

/**
 * A fee override, refused before it can reach a node.
 *
 * `sendTransaction` applies the same ceiling and would refuse this too, so the
 * check here buys one thing: the refusal arrives before any round trip and
 * before the wallet has been asked to sign, which is where somebody can still
 * act on it. A fee is the one field where a typo is unbounded — everything else
 * fails safely, while `maxFeePerGas` is multiplied by gas used and taken with a
 * valid signature on it.
 */
function feePerGas(value, field) {
  const fee = whole(value, field)
  if (fee !== undefined && fee > FEE_PER_GAS_CEILING) {
    throw new Error(
      `${field} of ${fee} wei per gas is above the ceiling of ${FEE_PER_GAS_CEILING} wei, which is 10,000 gwei. Nothing on this network asks for anything like it, so check whether a figure meant as gwei has been given as wei.`
    )
  }
  return fee
}

function requireUnlocked(wallet) {
  const { exists, unlocked } = wallet.status()
  if (unlocked) return

  // Told apart because they call for different things. A locked wallet needs a
  // password; one that does not exist needs somebody to make it, and being told
  // to unlock something that was never there is a confusing place to start.
  throw new Error(
    exists
      ? 'the wallet is locked. Its record of what it has sent is sealed under the account, so there is no way to read it without unlocking first.'
      : 'there is no wallet on this machine yet, so there is nothing it can have sent.'
  )
}

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
 * One ledger per context, so that these handlers and the ones that will call
 * {@link recordTransaction} share it rather than each keeping a separate idea
 * of what has been written.
 */
const ledgers = new WeakMap()

function transactionLedger(ctx) {
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
   * The chain id is asked for rather than taken from `NETWORKS`, because it is
   * the chain the transaction was actually signed against — `sendTransaction`
   * used this same answer moments ago — and reconciliation compares the two. A
   * node that disagrees with the table would otherwise leave every entry
   * permanently unrecognised.
   */
  const record = async (kind, sent, { replaces = null } = {}) => {
    const chainId = await ctx
      .rpc()
      .chainId()
      .catch(() => NETWORKS[ctx.network()].chainId)

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
   * Catches every pending entry up with the chain.
   *
   * A `wait` lives in the memory of the process that started it, so anything
   * still in flight when the application closed comes back marked pending and
   * would stay that way for good. This is the answer: on every read, ask the
   * chain about each one directly.
   */
  const reconcile = async () => {
    const current = entries()
    const waiting = current.filter((entry) => entry.status === 'pending')
    if (waiting.length === 0) return current

    const rpc = ctx.rpc()

    let chainId
    try {
      chainId = await rpc.chainId()
    } catch {
      // No node to ask. Pending is then the truthful state rather than a stale
      // one, so it stays.
      return current
    }

    // Only what was sent to the chain now being spoken to. One account keeps
    // one ledger across both networks — the store is scoped per identity, not
    // per chain — and asking mainnet about a testnet hash gets a confident
    // "never heard of it" that would be read below as a transaction which never
    // happened.
    const mine = waiting.filter((entry) => entry.chainId === chainId)
    if (mine.length === 0) return current

    // `Rpc.transactionCount` asks for the pending count, which includes the
    // very transactions being reconciled and so always sits above their nonces.
    // The mined count answers the question actually worth asking: whether this
    // nonce has already been spent by something else, which is the only way to
    // establish that a pending transaction can never now be mined.
    const address = ctx.wallet.status().address
    const spent = await rpc
      .send('eth_getTransactionCount', [address, 'latest'])
      .then((count) => fromQuantity(count))
      .catch(() => null)

    const resolved = new Map()

    await Promise.all(
      mine.map(async (entry) => {
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
      })
    )

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
 * Records an outgoing transaction in this wallet's ledger.
 *
 * Exported for `handlers/ai.mjs`, whose `ai.fund` and `ai.withdraw` are the
 * other two places this application broadcasts anything. All three now record,
 * which is what lets the history claim to be every transaction this
 * application has made rather than most of them.
 *
 * Returns once the pending entry is written; the receipt is picked up in the
 * background. That ordering is the point of the function. The transaction is
 * already broadcast and cannot be recalled, so the record has to exist before
 * anything is awaited: a wait that times out, or an application closed while it
 * waits, must not be the difference between a transaction existing and this
 * wallet knowing that it does.
 */
export async function recordTransaction(ctx, kind, sent) {
  const ledger = transactionLedger(ctx)
  const entry = await ledger.record(kind, sent)
  ledger.follow(sent)
  return entry
}

export function walletHandlers(ctx) {
  const { wallet, rpc, network, useWalletInRooms, forgetInference } = ctx
  const ledger = transactionLedger(ctx)

  /**
   * The transaction a replacement has to repeat, rebuilt from the ledger.
   *
   * `SentTransaction` is a live object holding everything that was signed, and
   * it dies with the process that made it. After a restart the ledger is all
   * there is, so this reconstructs from it and refuses whenever the
   * reconstruction would be a guess. That bias is deliberate: a replacement
   * differing in any field from what it replaces is not a replacement, it is a
   * second transaction competing for one nonce, and the chain will mine
   * whichever it likes. Being told "no" is recoverable. Being told "sped up"
   * about a transfer that quietly changed its recipient is not.
   */
  const toReplace = async (hash, verb) => {
    requireUnlocked(wallet)
    if (!isHash(hash)) throw new Error(`${JSON.stringify(hash)} is not a transaction hash`)

    // Reconciled first. An entry mined while the application was closed is
    // still marked pending here, and replacing something that already landed is
    // the one mistake this must not make.
    const entries = await ledger.reconcile()
    const entry = entries.find((held) => held.hash.toLowerCase() === hash.toLowerCase())

    if (!entry) {
      throw new Error(
        `there is no record of ${hash}, so there is nothing to ${verb}. Only transactions this application sent, from this account, on this machine, can be replaced — everything else is missing the nonce and the exact contents a replacement has to repeat.`
      )
    }

    if (entry.status !== 'pending') {
      const where = entry.block ? ` in block ${entry.block}` : ''
      throw new Error(
        `${hash} is already ${entry.status}${where}. Its nonce is spent, so anything sent now would be a second transaction rather than a replacement of that one.`
      )
    }

    const chainId = await rpc().chainId()
    if (entry.chainId !== chainId) {
      throw new Error(
        `${hash} was sent on chain ${entry.chainId} and this wallet is connected to chain ${chainId}. Switch back to ${entry.network} before trying to ${verb} that transaction: a replacement signed for the wrong chain spends a nonce that has nothing to do with the one it was meant to replace.`
      )
    }

    const required = {
      to: isAddress,
      data: isCallData,
      value: isDecimal,
      gas: isDecimal,
      nonce: isDecimal,
      maxFeePerGas: isDecimal,
      maxPriorityFeePerGas: isDecimal
    }

    const unusable = Object.keys(required).filter((field) => !required[field](entry[field]))
    if (unusable.length > 0) {
      throw new Error(
        `the record of ${hash} cannot be read back (${unusable.join(', ')}), so a replacement could not repeat it exactly. Rather than sign something that differs from what it replaces, this refuses: wait for the original to be mined, or for the node to drop it.`
      )
    }

    return {
      entry,
      sent: {
        hash: entry.hash,
        nonce: BigInt(entry.nonce),
        gas: BigInt(entry.gas),
        maxFeePerGas: BigInt(entry.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(entry.maxPriorityFeePerGas),
        to: entry.to,
        value: BigInt(entry.value),
        data: entry.data,
        // Neither `speedUp` nor `cancel` calls this, but a SentTransaction
        // without one is a shape that lies about what it is, and the next
        // caller should not have to discover that.
        wait: (options) => rpc().waitForReceipt(entry.hash, options)
      }
    }
  }

  return {
    'wallet.status': () => ({ ...wallet.status(), network: network() }),

    // The one reply that carries a secret. The phrase has to reach a screen so
    // it can be written down, and it is not stored anywhere the renderer can
    // reach afterwards — seeing it again costs the password.
    'wallet.create': (req) => {
      const { status, phrase } = wallet.create(String(req.password ?? ''))
      useWalletInRooms()
      return { ...status, network: network(), phrase }
    },

    'wallet.import': (req) => {
      const status = wallet.importPhrase(String(req.phrase ?? ''), String(req.password ?? ''))
      useWalletInRooms()
      return { ...status, network: network() }
    },

    'wallet.reveal': (req) => ({ phrase: wallet.revealPhrase(String(req.password ?? '')) }),

    /**
     * Reseals under a new password. Nothing else moves.
     *
     * The transcript log and the room registry are sealed with keys derived
     * from the account's signature rather than from the password, so both stay
     * readable — which is why they were derived that way.
     */
    'wallet.changePassword': (req) => ({
      ...wallet.changePassword(String(req.current ?? ''), String(req.next ?? '')),
      network: network()
    }),

    'wallet.unlock': (req) => {
      const status = wallet.unlock(String(req.password ?? ''))
      useWalletInRooms()
      return { ...status, network: network() }
    },

    'wallet.lock': () => {
      // Locking has to end the conversation too. The session was opened by this
      // address and is paid for by it, and leaving it live would be a locked
      // wallet still spending.
      forgetInference()
      const locked = wallet.lock()
      useWalletInRooms()
      return { ...locked, network: network() }
    },

    'wallet.remove': (req) => {
      const status = wallet.remove(String(req.password ?? ''))
      forgetInference()
      useWalletInRooms()
      return { ...status, network: network() }
    },

    /**
     * The first few addresses of this phrase, without moving to any of them.
     *
     * `Wallet.addressAt` is the obvious call and the wrong one at this size: it
     * opens the vault per address, and the vault costs half a second of scrypt
     * by design, so five addresses would take two and a half seconds to list.
     * The phrase is opened once instead and the addresses derived from it —
     * identical arithmetic to what `addressAt` does internally, at one scrypt
     * rather than five. The cost is that the phrase and each derived key sit in
     * a local variable here for the length of a loop, which is a real exposure
     * and a small one next to `wallet.reveal`, which hands the same phrase all
     * the way to a window.
     */
    'wallet.accounts': (req) => {
      const count = Math.min(MAX_ACCOUNTS, Math.max(1, Number(req.count) || DEFAULT_ACCOUNTS))
      const phrase = wallet.revealPhrase(String(req.password ?? ''))

      const accounts = []
      for (let index = 0; index < count; index++) {
        accounts.push({ index, address: fromPrivateKey(derivePrivateKey(phrase, index)).address })
      }

      return { accounts }
    },

    /**
     * Moves to another account of the same phrase.
     *
     * A second identity rather than a second address for the first one, and
     * everything downstream follows the account: the room list, the transcript
     * log, local preferences and the ledger below are each sealed under a key
     * only the active account can derive. So this looks, from a window, like
     * the application forgetting everything — and switching back brings all of
     * it straight home. An interface should say so before offering the switch
     * rather than leave somebody to conclude their history was destroyed.
     *
     * The conversation goes with the account. It was opened by the old address
     * and is paid for out of its prepaid balance, and carrying it across would
     * be one identity spending another's money.
     */
    'wallet.switchAccount': (req) => {
      const status = wallet.switchAccount(String(req.password ?? ''), Number(req.index))
      forgetInference()
      useWalletInRooms()
      return { ...status, network: network() }
    },

    /**
     * A keystore V3 file for one account, for tools that want a file.
     *
     * Encrypted under the same password the vault uses, because asking for a
     * second one at this point invites the answer "the same one" typed badly.
     * The phrase is still the real backup: this holds a single account's key
     * and cannot reconstruct the others.
     *
     * An absent index means the first account, but a malformed one is refused
     * rather than rounded to zero — exporting the wrong account's private key
     * without saying so is not a mistake anybody would catch.
     */
    'wallet.exportKeystore': (req) => ({
      keystore: wallet.exportKeystore(
        String(req.password ?? ''),
        req.index === undefined ? 0 : Number(req.index)
      )
    }),

    'wallet.balances': async () => {
      const { address } = wallet.status()
      if (!address) return { address: null }

      // Balances are public, so they are readable while locked. Only signing
      // needs the key.
      const [native, addresses] = await Promise.all([
        rpc().balanceOf(address),
        resolveAddresses(rpc()).catch(() => null)
      ])

      const prepaid = addresses
        ? await prepaidBalance(rpc(), addresses.jobRegistry, address).catch(() => null)
        : null

      return {
        address,
        network: network(),
        chainId: NETWORKS[network()].chainId,
        native: native.toString(),
        prepaid: prepaid === null ? null : prepaid.toString()
      }
    },

    /**
     * What the fee market is asking, so a window can show it before anyone signs.
     *
     * Public, like a balance, and so readable while locked. `maxFeePerGas` is a
     * ceiling rather than a price — the difference between it and
     * `baseFeePerGas + maxPriorityFeePerGas` at inclusion is refunded — so the
     * three numbers should not be presented as three costs. Only the middle one
     * is a choice.
     */
    'wallet.fees': async () => {
      const fees = await rpc().fees()
      return {
        network: network(),
        baseFeePerGas: fees.baseFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString()
      }
    },

    /**
     * Sends LCAI from this wallet to another address.
     *
     * A plain value transfer, with nothing clever around it. The recipient is
     * whatever the caller passes, and the caller got it from a message this
     * machine verified the signature on — which is the only reason an address
     * in a chat room is safe to pay: it was proven, not typed.
     *
     * The fee fields and the nonce are optional overrides, and each is only
     * worth offering with an explanation attached. Raising `maxFeePerGas` buys
     * patience against a rising base fee and costs nothing by itself; setting a
     * nonce by hand is how a replacement is sent, and how a gap gets left in
     * the sequence that holds up everything queued behind it.
     */
    'wallet.send': async (req) => {
      const to = String(req.to ?? '')
      if (!isAddress(to)) throw new Error('that is not an address')

      const account = wallet.account()
      if (to.toLowerCase() === account.address.toLowerCase()) {
        throw new Error('that is your own address')
      }

      const sent = await sendTransaction(rpc(), account, {
        to,
        value: whole(req.amount, 'amount') ?? 0n,
        maxFeePerGas: feePerGas(req.maxFeePerGas, 'maxFeePerGas'),
        maxPriorityFeePerGas: feePerGas(req.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
        nonce: whole(req.nonce, 'nonce')
      })

      // Written down before the wait, not after it. See recordTransaction.
      await ledger.record('send', sent)

      const receipt = await sent.wait()
      ledger.settle(sent.hash, receipt)

      if (!receipt.status) throw new Error(`the transfer reverted (${sent.hash})`)

      return { hash: sent.hash, block: receipt.blockNumber.toString() }
    },

    /**
     * Everything this wallet has sent, newest first.
     *
     * Local, partial, and this application's own activity rather than the
     * account's — see the ledger above, and label it accordingly.
     *
     * Every read reconciles what is still pending against the chain, which
     * costs a round trip or three and is the only thing standing between a
     * transaction interrupted by a restart and an entry that says "pending"
     * for the rest of the installation's life.
     */
    'wallet.history': async () => {
      requireUnlocked(wallet)
      const entries = await ledger.reconcile()
      return { entries: [...entries].sort((a, b) => b.at - a.at) }
    },

    /**
     * Bids more for a transaction that is taking too long.
     *
     * Same recipient, same value, same data, same nonce, higher fees. The
     * result is two transactions competing for one nonce, of which the chain
     * mines exactly one — so this cannot pay twice, but it can leave the
     * original as the one that landed. Watch the returned hash, and the
     * original's, to learn which.
     */
    'wallet.speedUp': async (req) => {
      const { entry, sent } = await toReplace(String(req.hash ?? ''), 'speed up')

      const faster = await speedUp(rpc(), wallet.account(), sent)
      await ledger.record(entry.kind, faster, { replaces: entry.hash })
      ledger.follow(faster)

      return { hash: faster.hash }
    },

    /**
     * Races a pending transaction with an empty one at the same nonce.
     *
     * Nothing is undone here and nothing can be. Either this wins and the
     * original never happens, or it loses and the original happens exactly as
     * it was sent; there is no third outcome and no way to know in advance
     * which it will be. An interface that calls this "cancel" without saying so
     * is promising something the chain does not offer.
     */
    'wallet.cancel': async (req) => {
      const { entry, sent } = await toReplace(String(req.hash ?? ''), 'cancel')

      const stopped = await cancel(rpc(), wallet.account(), sent)
      await ledger.record('cancel', stopped, { replaces: entry.hash })
      ledger.follow(stopped)

      return { hash: stopped.hash }
    }
  }
}
