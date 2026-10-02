import path from 'bare-path'
import fs from 'bare-fs'
import fetch from 'bare-fetch'
import { NETWORKS } from '@lcai-p2p/worker'
import { encodeCall, sendTransaction } from '@lcai-p2p/chain'
import {
  DEPOSIT_CONTRACT_ADDRESS,
  buildDeposit,
  fromHex,
  generateValidatorPhrase,
  seedFromPhrase
} from '@lcai-p2p/validator'
import { readableAmount } from '../guard.mjs'
import { recordTransaction } from './wallet.mjs'

/**
 * Validators, which are not workers with a bigger number attached.
 *
 * A worker stakes 50,000 LCAI, runs a model on a GPU and is paid per inference
 * job. A validator stakes 500,000, runs an execution client and a consensus
 * client, and is paid for proposing and attesting blocks. They share a token
 * and nothing else — different stake, different keys, different software,
 * different failure modes — and the one page that used to cover both taught
 * people the second was a setting of the first.
 *
 * What this file will and will not do is a deliberate line. It reads the beacon
 * chain, derives deposit keys, and sends the deposit. It does not install or
 * supervise the two chain clients: those are hundreds of gigabytes of state,
 * a slashing-protection database whose loss can cost the stake, and a process
 * that must outlive this window. An application that pretended otherwise would
 * be making a promise it drops the moment somebody quits it.
 */

const GWEI = 1_000_000_000n

/** Where the public record of this machine's validators lives. */
function recordPath(chatDir, network) {
  return path.join(chatDir, `validators-${network}.json`)
}

/**
 * The public half of what we know, and only the public half.
 *
 * The phrase behind these keys is deliberately not stored anywhere — not
 * sealed, not encrypted, not at all. It is shown once, written down, and typed
 * back in when it is needed. A validator phrase is worth 500,000 LCAI and
 * unlocks signing for as long as the validator exists; the safest place for it
 * is not on the machine that is also running the validator.
 */
function readRecord(chatDir, network) {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(chatDir, network), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRecord(chatDir, network, entries) {
  fs.writeFileSync(recordPath(chatDir, network), JSON.stringify(entries, null, 2), { mode: 0o600 })
}

/** A beacon API call, answering null rather than throwing on anything at all. */
async function beacon(url, route, timeout = 15_000) {
  try {
    let timer
    const res = await Promise.race([
      fetch(`${url}${route}`),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeout)
        timer.unref?.()
      })
    ])
    clearTimeout(timer)
    if (!res || !res.ok) return null
    return (await res.json())?.data ?? null
  } catch {
    return null
  }
}

/**
 * The one number that decides whether any of this is worth starting.
 *
 * Read from the chain's own `/config/spec` rather than pinned here. Lightchain
 * asks 500,000 LCAI today; it is a chain parameter and chains change them, and
 * a figure compiled into an application is a figure that goes quietly wrong.
 */
function gweiFrom(spec, key) {
  const raw = spec?.[key]
  if (raw === undefined || raw === null) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

export function validatorHandlers(ctx) {
  const { chatDir, chainId, guard, network, rpc, wallet } = ctx

  const profile = () => NETWORKS[network()]

  /** The chain's own numbers, so nothing here is a constant that can rot. */
  async function spec() {
    const url = profile().beaconApiUrl
    const [config, genesis, syncing] = await Promise.all([
      beacon(url, '/eth/v1/config/spec'),
      beacon(url, '/eth/v1/beacon/genesis'),
      beacon(url, '/eth/v1/node/syncing')
    ])
    return { config, genesis, syncing }
  }

  return {
    /**
     * What this network asks of a validator, and what its validator set looks
     * like — all of it live.
     *
     * Null fields mean the beacon chain could not be asked, which is a
     * different thing from a network with no validators and must not render
     * the same way.
     */
    'validator.network': async () => {
      const { config, genesis, syncing } = await spec()

      // The standard beacon API has no count endpoint, so the set is listed and
      // counted. Fine at this chain's scale and guarded so a much larger one
      // reports "too many to count" rather than pulling megabytes into a panel.
      const balances = await beacon(
        profile().beaconApiUrl,
        '/eth/v1/beacon/states/head/validator_balances',
        25_000
      )

      const activation = gweiFrom(config, 'MIN_ACTIVATION_BALANCE')
      const ejection = gweiFrom(config, 'EJECTION_BALANCE')

      return {
        network: network(),
        // Where a deposit goes. The chain names it; the package's constant is
        // only a fallback for a spec that does not.
        depositContract: config?.DEPOSIT_CONTRACT_ADDRESS ?? DEPOSIT_CONTRACT_ADDRESS,
        depositChainId: config?.DEPOSIT_CHAIN_ID ? Number(config.DEPOSIT_CHAIN_ID) : null,
        genesisForkVersion: genesis?.genesis_fork_version ?? null,
        // Wei, as decimal strings: JSON has no bigint and these are large.
        activationWei: activation === null ? null : (activation * GWEI).toString(),
        ejectionWei: ejection === null ? null : (ejection * GWEI).toString(),
        validators: Array.isArray(balances) ? balances.length : null,
        headSlot: syncing?.head_slot ? Number(syncing.head_slot) : null,
        syncing: syncing?.is_syncing ?? null,
        reachable: config !== null
      }
    },

    /**
     * The validators this machine has keys for, and what the chain says about
     * each of them.
     *
     * The record is public data written locally; the status beside it is read
     * live, because "your deposit was accepted and you are 14th in the
     * activation queue" is the only answer anybody wants after depositing and
     * it is not a thing a local file can know.
     */
    'validator.keys': async () => {
      const entries = readRecord(chatDir, network())
      if (entries.length === 0) return { network: network(), keys: [] }

      const url = profile().beaconApiUrl
      const query = entries.map((entry) => `id=${entry.pubkey}`).join('&')
      const live = await beacon(url, `/eth/v1/beacon/states/head/validators?${query}`, 20_000)

      const byKey = new Map()
      for (const item of Array.isArray(live) ? live : []) {
        if (item?.validator?.pubkey) byKey.set(item.validator.pubkey.toLowerCase(), item)
      }

      return {
        network: network(),
        keys: entries.map((entry) => {
          const found = byKey.get(entry.pubkey.toLowerCase())
          return {
            ...entry,
            // Null means the chain has never heard of this key — which is the
            // ordinary state between generating keys and depositing, and is
            // said as that rather than as an error.
            status: found?.status ?? null,
            index: found?.index ?? null,
            balanceWei: found?.balance ? (BigInt(found.balance) * GWEI).toString() : null
          }
        })
      }
    },

    /**
     * A fresh phrase and the deposits it authorises.
     *
     * The phrase is returned once and stored nowhere. Everything derived from
     * it is derived again from the same phrase whenever it is needed, which is
     * why losing it loses the validator — said plainly on the page rather than
     * softened.
     *
     * Withdrawals are pointed at this app's wallet by default: the `0x01`
     * credential form, which removes the whole class of "the stake is stuck
     * behind a BLS key nobody kept" failures.
     */
    'validator.createKeys': async (req) => {
      const count = Number(req.count ?? 1)
      if (!Number.isInteger(count) || count < 1 || count > 16) {
        throw new Error('choose between 1 and 16 validators')
      }

      const account = wallet.account()
      const withdrawalAddress =
        typeof req.withdrawalAddress === 'string' && req.withdrawalAddress !== ''
          ? req.withdrawalAddress
          : account.address

      const { config, genesis } = await spec()
      const forkVersion = genesis?.genesis_fork_version
      const activation = gweiFrom(config, 'MIN_ACTIVATION_BALANCE')

      // Refused rather than guessed. A fork version invented here signs a
      // deposit the chain will ignore, and the money does not come back.
      if (!forkVersion || activation === null) {
        throw new Error(
          `the ${network()} beacon chain could not be read, and a deposit signed against a guessed fork version is one this chain would ignore - with the stake already spent`
        )
      }

      const phrase = generateValidatorPhrase()
      const seed = seedFromPhrase(phrase)

      const existing = readRecord(chatDir, network())
      const first = existing.reduce((highest, entry) => Math.max(highest, entry.index + 1), 0)

      const deposits = []
      for (let i = 0; i < count; i++) {
        const deposit = buildDeposit({
          seed,
          index: first + i,
          withdrawalAddress,
          amountGwei: activation,
          forkVersion: fromHex(forkVersion)
        })
        deposits.push({ ...deposit, amount: deposit.amount.toString() })
      }

      return { phrase, withdrawalAddress, deposits, network: network() }
    },

    /**
     * The same derivation from a phrase somebody already has.
     *
     * The way back after a reinstall, and the way to add validators to a phrase
     * without generating a second one to keep track of.
     */
    'validator.recoverKeys': async (req) => {
      const count = Number(req.count ?? 1)
      if (!Number.isInteger(count) || count < 1 || count > 16) {
        throw new Error('choose between 1 and 16 validators')
      }

      const seed = seedFromPhrase(String(req.phrase ?? ''))
      const account = wallet.account()
      const withdrawalAddress =
        typeof req.withdrawalAddress === 'string' && req.withdrawalAddress !== ''
          ? req.withdrawalAddress
          : account.address

      const { config, genesis } = await spec()
      const forkVersion = genesis?.genesis_fork_version
      const activation = gweiFrom(config, 'MIN_ACTIVATION_BALANCE')
      if (!forkVersion || activation === null) {
        throw new Error(`the ${network()} beacon chain could not be read`)
      }

      const from = Number(req.from ?? 0)
      const deposits = []
      for (let i = 0; i < count; i++) {
        const deposit = buildDeposit({
          seed,
          index: from + i,
          withdrawalAddress,
          amountGwei: activation,
          forkVersion: fromHex(forkVersion)
        })
        deposits.push({ ...deposit, amount: deposit.amount.toString() })
      }

      return { withdrawalAddress, deposits, network: network() }
    },

    /**
     * The deposit itself: the largest, least reversible thing this application
     * can be asked to do.
     *
     * It goes through the guard like any other transfer, so the amount and the
     * destination are put to a person before anything is signed — and the
     * destination named in that dialog is the deposit contract the beacon chain
     * itself gave us, not one from this source.
     *
     * The record is written after the transaction is accepted, so a refused
     * deposit leaves nothing behind claiming a validator exists.
     */
    'validator.deposit': async (req) => {
      const { config } = await spec()
      const contract = config?.DEPOSIT_CONTRACT_ADDRESS ?? DEPOSIT_CONTRACT_ADDRESS

      for (const field of ['pubkey', 'withdrawalCredentials', 'signature', 'depositDataRoot']) {
        if (typeof req[field] !== 'string' || !/^0x[0-9a-fA-F]+$/.test(req[field])) {
          throw new Error(`${field} is missing from this deposit`)
        }
      }

      const value = BigInt(req.amount) * GWEI

      const data = encodeCall(
        'deposit(bytes,bytes,bytes,bytes32)',
        ['bytes', 'bytes', 'bytes', 'bytes32'],
        [req.pubkey, req.withdrawalCredentials, req.signature, req.depositDataRoot]
      )

      const account = wallet.account()
      await guard.allow({
        value,
        chainId: BigInt(profile().chainId),
        details: {
          amount: `${readableAmount(value, profile().symbol)} deposited to activate a validator`,
          to: `the beacon deposit contract at ${contract}`,
          from: account.address,
          network: network()
        }
      })

      // The ordinary send path, so the nonce, the fee market and the ledger
      // entry are the same ones every other transaction from this wallet gets.
      const sent = await sendTransaction(rpc(), account, {
        to: contract,
        value,
        data,
        chainId: chainId()
      })

      // Recorded before the wait. The transaction is broadcast and cannot be
      // recalled, so a wait that times out must not decide whether this wallet
      // knows that 500,000 LCAI left it.
      await recordTransaction(ctx, 'validator-deposit', sent)

      const entries = readRecord(chatDir, network())
      entries.push({
        pubkey: req.pubkey,
        index: Number(req.index ?? entries.length),
        withdrawalCredentials: req.withdrawalCredentials,
        amountWei: value.toString(),
        hash: sent.hash
      })
      writeRecord(chatDir, network(), entries)

      return { ok: true, hash: sent.hash }
    },

    /** Stops tracking a key here. Nothing on chain changes; this is a list. */
    'validator.forget': (req) => {
      const pubkey = String(req.pubkey ?? '').toLowerCase()
      const entries = readRecord(chatDir, network()).filter(
        (entry) => entry.pubkey.toLowerCase() !== pubkey
      )
      writeRecord(chatDir, network(), entries)
      return { ok: true }
    }
  }
}
