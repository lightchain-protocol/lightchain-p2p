import {
  FEE_PER_GAS_CEILING,
  SETTLE_CONFIRMATIONS,
  cancel,
  fromPrivateKey,
  keccak256,
  prepaidBalance,
  resolveAddresses,
  sendTransaction,
  speedUp,
  toChecksumAddress,
  upfrontCost
} from '@lcai-p2p/chain'
import { REPLACE_CONFIRMATION, derivePrivateKey } from '@lcai-p2p/wallet'
import { NETWORKS } from '@lcai-p2p/worker'
import { DEFAULT_CONFIRM_ABOVE, readableAmount } from '../guard.mjs'
import {
  isDecimal,
  recordTransaction as recordOnChain,
  transactionLedger
} from '../ledger.mjs'

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
 * The ledger itself — the sealed `transactions` document, the reconcile pass
 * and the chain-aware {@link recordTransaction} — lives in `../ledger.mjs`,
 * extracted so that handlers sending on chains other than the connected one can
 * write to it too. What stays here is the wallet's own use of it.
 */

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

/**
 * That replacing a wallet leaves the room lists and sealed documents alone.
 *
 * Reported rather than left for a window to assume, because it is the one
 * reassurance the confirmation screen can honestly give. Those files are sealed
 * under keys derived from the account's signature, so the same phrase restored
 * afterwards opens them again exactly as they were — and deleting them here to
 * tidy up would turn "your rooms come back" into a promise nothing on this
 * machine could keep.
 */
const KEPT_ON_DISK = true

const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
const isHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
const isCallData = (value) => typeof value === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(value)

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

/**
 * A proof the renderer sent, with an untouched box counting as none.
 *
 * Absent and empty mean the same thing to `Wallet`, and neither is tidied up on
 * the way through: the confirmation is compared exactly, on purpose, so
 * trimming it here would quietly undo the strictness it is there for. An empty
 * password is dropped for a different reason — sent as a proof it would be
 * answered with "wrong password", which is a confusing thing to tell somebody
 * who typed the confirmation instead.
 */
function offered(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
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
 * The words for "the balance does not cover this", written once so that the
 * pre-check in `wallet.send` and the node's own refusal — which arrives as a
 * raw "insufficient funds for gas * price + value…" RPC string — read
 * identically to the person who has to act on them.
 */
const cannotCover = (symbol) =>
  `this wallet cannot cover that — the amount plus the network fee is more than it holds. Lower the amount, or receive some ${symbol} first.`

/**
 * Records an outgoing transaction in this wallet's ledger, on the connected
 * chain.
 *
 * The Lightchain-side convenience form of `../ledger.mjs`'s chain-aware
 * `recordTransaction(ctx, rpc, txish)`: the sending client is `ctx.rpc()` and
 * the chain-id fallback is the connected network's table entry, exactly as it
 * was before the extraction. Handlers broadcasting on another chain — swap and
 * bridge — call the ledger module directly with that chain's client.
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
  return recordOnChain(ctx, ctx.rpc(), { kind, ...sent })
}

export function walletHandlers(ctx) {
  const { wallet, rpc, network, useWalletInRooms, forgetInference, guard, saveSettings } = ctx
  const ledger = transactionLedger(ctx)

  /**
   * The guard's confirmation threshold, read the way the guard reads it.
   *
   * This is the line between a send that waits one block and a send that
   * waits three: below it a transfer goes fast, because speed is the point of
   * a small payment and the guard already priced its risk; at or above it the
   * wait goes {@link SETTLE_CONFIRMATIONS} deep before anybody is told the
   * money arrived. The setting is honoured rather than the default alone, so
   * the line a person moved is the line both behaviours follow.
   */
  const confirmThreshold = () => {
    const raw = ctx.settings?.()?.confirmAboveWei
    return typeof raw === 'string' && /^[0-9]+$/.test(raw) ? BigInt(raw) : DEFAULT_CONFIRM_ABOVE
  }

  /**
   * Points the rooms and the conversation at whichever identity the wallet
   * holds now.
   *
   * A replacement takes the long way round, and has to. `useWalletInRooms`
   * only lets go of the previous account's registry key while the wallet reads
   * as locked — the lock is what closes the room list — so a replacement
   * applied in one step would leave the new identity signing into the room
   * list of the wallet it displaced, a state nothing downstream expects and
   * nothing on screen would reveal. Going out through locked and back in costs
   * a second scrypt, which is the right price for something that happens once,
   * on the day somebody replaces their wallet.
   *
   * The conversation is dropped either way. It was opened by an address and is
   * paid for out of that address's prepaid balance, so one carried across a
   * replacement would be the new wallet spending the old one's money; where
   * there was no wallet before there is no session, and the call costs nothing.
   */
  const adoptIdentity = (replaced, password) => {
    if (replaced) {
      wallet.lock()
      useWalletInRooms()
      wallet.unlock(password)
    }

    forgetInference()
    useWalletInRooms()
  }

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

    /**
     * The one reply that carries a secret. The phrase has to reach a screen so
     * it can be written down, and it is not stored anywhere the renderer can
     * reach afterwards — seeing it again costs the password.
     *
     * A wallet already here is refused unless `confirmation` holds the word,
     * and `replaced` in the reply says whether one was destroyed to get here.
     * Somebody has to be told that, and this is the last chance to tell them.
     */
    'wallet.create': (req) => {
      const password = String(req.password ?? '')
      const { status, phrase } = wallet.create(password, {
        confirmation: offered(req.confirmation)
      })

      adoptIdentity(status.replaced, password)
      return { ...status, network: network(), phrase }
    },

    /**
     * Restores a phrase, over a wallet already here when `confirmation` allows it.
     *
     * `passphrase` is BIP-39's 25th word, for a phrase created with one in
     * another wallet. Nothing can check it: a wrong one is not an error, it is
     * a different and perfectly valid empty wallet. The address in the reply is
     * the only confirmation available, which is why a screen offering the field
     * should show it and ask whether it looks right.
     */
    'wallet.import': (req) => {
      const password = String(req.password ?? '')
      const status = wallet.importPhrase(String(req.phrase ?? ''), password, {
        confirmation: offered(req.confirmation),
        // Not trimmed, not lowercased. Both are significant to the derivation,
        // and tidying one here would restore a different wallet than the one
        // the passphrase was written for.
        passphrase: typeof req.passphrase === 'string' ? req.passphrase : ''
      })

      adoptIdentity(status.replaced, password)
      return { ...status, network: network() }
    },

    /**
     * The address a phrase and passphrase would produce, without committing.
     *
     * The counterpart to the warning above. Somebody restoring a wallet that
     * used a passphrase has no way to tell a right one from a wrong one except
     * by recognising the address, and asking them to destroy the wallet they
     * have in order to find out is not an acceptable way to offer that.
     */
    'wallet.previewImport': (req) => {
      const phrase = String(req.phrase ?? '')
      const passphrase = typeof req.passphrase === 'string' ? req.passphrase : ''

      return {
        address: fromPrivateKey(derivePrivateKey(phrase, 0, passphrase)).address,
        hasPassphrase: passphrase !== ''
      }
    },

    /**
     * How long the wallet waits before locking itself.
     *
     * Minutes, because that is the unit somebody choosing it thinks in. Zero
     * switches it off, which is a defensible choice on a machine only one
     * person uses and a terrible one on a shared desk — so the interface says
     * which it is rather than presenting a neutral list.
     */
    'wallet.setAutoLock': (req) => {
      // Typed rather than coerced. `Number(null)` is zero, and zero means never
      // lock — so a missing field would have switched the lock off entirely.
      const minutes = req.minutes
      if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
        throw new Error('the lock time has to be a whole number of minutes')
      }
      if (minutes < 0 || minutes > 24 * 60) {
        throw new Error('the lock time has to be between zero minutes and a day')
      }

      const status = wallet.setAutoLock(minutes * 60 * 1000)
      saveSettings({ ...ctx.settings(), autoLockMinutes: String(minutes) })
      return { ...status, network: network() }
    },

    /**
     * Says somebody is still here, without doing anything.
     *
     * The window sends this while it is being used so that reading a long
     * thread does not read as an empty room. It cannot unlock anything and it
     * cannot extend a wallet that has already locked.
     */
    'wallet.touch': () => {
      wallet.touch()
      return { ...wallet.status(), network: network() }
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

    /**
     * Destroys the wallet on this machine, for the password or for the word.
     *
     * Send one proof, not both: a password that is present and wrong is
     * refused even alongside a correct confirmation, because a caller claiming
     * ownership should be told when the claim fails rather than quietly
     * succeeding by the weaker route.
     */
    'wallet.remove': (req) => {
      const status = wallet.remove({
        password: offered(req.password),
        confirmation: offered(req.confirmation)
      })

      forgetInference()
      useWalletInRooms()
      return { ...status, network: network() }
    },

    /**
     * What replacing the wallet on this machine costs, and what it does not.
     *
     * Read-only, needs no password, and exists so the screen that asks for
     * {@link REPLACE_CONFIRMATION} can describe the thing it is about to
     * destroy without overstating it.
     *
     * `address` is null whenever the wallet is locked, and that is not a
     * shortcoming to work around. The vault holds a salt, an IV, a tag and
     * ciphertext; the address lives in the phrase and the phrase is inside the
     * ciphertext, so on a machine nobody can unlock there is genuinely no way
     * to name the wallet being replaced. A window must say "the wallet on this
     * machine" rather than invent one.
     *
     * No network here, unlike the replies that carry a balance. The address is
     * shown to identify what is about to go, not to be acted on, and naming a
     * chain beside it would invite a window to present this as an account.
     */
    'wallet.replacePreview': () => {
      const { exists, address } = wallet.status()
      return { exists, address, keptOnDisk: KEPT_ON_DISK, confirmation: REPLACE_CONFIRMATION }
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

      const value = whole(req.amount, 'amount') ?? 0n
      const maxFeePerGas = feePerGas(req.maxFeePerGas, 'maxFeePerGas')
      const maxPriorityFeePerGas = feePerGas(req.maxPriorityFeePerGas, 'maxPriorityFeePerGas')
      const symbol = NETWORKS[network()].symbol

      // Cheap truth before an expensive failure. Without this, a transfer the
      // balance cannot cover is signed, broadcast and refused by the node,
      // whose answer is a raw "insufficient funds for gas * price + value…"
      // string naming nothing anybody can act on. The arithmetic is the same
      // one the node applies before accepting a transaction — the gas limit
      // times the fee cap, plus the value itself — so the refusal arrives
      // here instead, before a dialog, a signature or a broadcast, and in
      // plain words.
      const [balance, market] = await Promise.all([
        rpc().balanceOf(account.address),
        // Only needed when the caller has not named a fee cap of their own.
        maxFeePerGas === undefined ? rpc().fees() : Promise.resolve(null)
      ])

      // The estimate mirrors sendTransaction's, margin included. When the
      // estimate itself cannot be had — a recipient whose code reverts, a node
      // that will not answer — the intrinsic cost of a plain transfer stands
      // in: the real send hits the same failure and reports it, while the
      // common case this check exists for, an empty or nearly empty wallet, is
      // still caught.
      const gas = await rpc()
        .estimateGas({ from: account.address, to, data: '0x', value })
        .then((estimate) => (estimate * 125n) / 100n)
        .catch(() => (21_000n * 125n) / 100n)

      if (balance < upfrontCost(gas, maxFeePerGas ?? market.maxFeePerGas, value)) {
        throw new Error(cannotCover(symbol))
      }

      // Before anything is signed, and describing the transfer from the values
      // about to be used rather than from the request. A window that asked for
      // one amount and displayed another is exactly what this exists to catch.
      await guard.allow({
        value,
        details: {
          amount: readableAmount(value, symbol),
          // Checksummed, because the dialog is where somebody checks the
          // destination character by character and mixed case is what makes a
          // wrong one visible.
          to: toChecksumAddress(to, keccak256),
          from: account.address,
          network: network()
        }
      })

      let sent
      try {
        sent = await sendTransaction(rpc(), account, {
          to,
          value,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce: whole(req.nonce, 'nonce'),
          chainId: ctx.chainId()
        })
      } catch (err) {
        // The balance can move between the check above and the node seeing the
        // transaction — the fee market jumps, or another transaction of ours
        // lands first and takes the nonce's worth out of the balance. The node
        // reports it as the same raw RPC string; say what is actually missing
        // instead.
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(cannotCover(symbol), { cause: err })
        }
        throw err
      }

      // Written down before the wait, not after it. See recordTransaction.
      await ledger.record(rpc(), 'send', sent)

      // Depth matched to the amount. One confirmation is inclusion, not
      // finality — the block can still be reorganised away — so a send at or
      // above the guard's own threshold waits three deep before reporting
      // success, while a small one keeps the shallow wait it always had.
      const receipt = await sent.wait(
        value >= confirmThreshold() ? { confirmations: SETTLE_CONFIRMATIONS } : undefined
      )
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

      const faster = await speedUp(rpc(), wallet.account(), sent, undefined, ctx.chainId())
      await ledger.record(rpc(), entry.kind, faster, { replaces: entry.hash })
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

      const stopped = await cancel(rpc(), wallet.account(), sent, undefined, ctx.chainId())
      await ledger.record(rpc(), 'cancel', stopped, { replaces: entry.hash })
      ledger.follow(stopped)

      return { hash: stopped.hash }
    }
  }
}
