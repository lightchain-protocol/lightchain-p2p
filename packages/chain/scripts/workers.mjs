// Who is actually online, on each network, before any money moves.
//
// The registry keeps an eligibility list per model, so this is answerable from
// the chain alone — no session, no deposit, no faith in a fee table.

import {
  Rpc,
  WORKER_REGISTRY_ADDRESS,
  decodeUint256,
  encodeCall,
  lightchainErrors,
  resolveAddresses,
  toBytes,
  toHex
} from '@lcai-p2p/chain'

const NETWORKS = {
  mainnet: {
    rpc: 'https://rpc.mainnet.lightchain.ai',
    api: 'https://chat-api.mainnet.lightchain.ai'
  },
  testnet: {
    rpc: 'https://rpc.testnet.lightchain.ai',
    api: 'https://chat-api.testnet.lightchain.ai'
  }
}

/** `address[]`: a head offset, then a length, then one word each. */
function decodeAddresses(raw) {
  const bytes = toBytes(raw)
  if (bytes.length < 64) return []
  const offset = Number(decodeUint256(toHex(bytes.slice(0, 32))))
  const count = Number(decodeUint256(toHex(bytes.slice(offset, offset + 32))))

  const out = []
  for (let i = 0; i < count; i++) {
    const at = offset + 32 + i * 32
    out.push(toHex(bytes.slice(at + 12, at + 32)))
  }
  return out
}

const lcai = (wei) => {
  const s = BigInt(wei).toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, '') || '0'}`
}

for (const [name, profile] of Object.entries(NETWORKS)) {
  console.log(`\n══ ${name}`)
  const rpc = new Rpc({ url: profile.rpc, errors: lightchainErrors() })
  const { aiConfig } = await resolveAddresses(rpc)

  let models
  try {
    const res = await fetch(`${profile.api}/api/models`, { signal: AbortSignal.timeout(20_000) })
    models = (await res.json()).models ?? []
  } catch (err) {
    console.log(`  could not list models: ${err.message}`)
    continue
  }

  for (const model of models) {
    let fee = 'unpriced'
    try {
      fee =
        lcai(
          decodeUint256(
            await rpc.call({
              to: aiConfig,
              data: encodeCall('calculateJobFee(bytes32)', ['bytes32'], [model.id])
            })
          )
        ) + ' LCAI'
    } catch {
      // A model with no fee cannot be paid for, so it cannot be used.
    }

    let workers
    try {
      workers = decodeAddresses(
        await rpc.call({
          to: WORKER_REGISTRY_ADDRESS,
          data: encodeCall('getEligibleWorkers(bytes32)', ['bytes32'], [model.id])
        })
      )
    } catch (err) {
      console.log(
        `  ${model.name.padEnd(24)} registry refused: ${(err.reason ?? err.message).slice(0, 40)}`
      )
      continue
    }

    const mark = workers.length > 0 ? 'yes' : ' no'
    console.log(
      `  ${mark}  ${model.name.padEnd(24)} ${String(workers.length).padStart(2)} eligible   ${fee}`
    )
    for (const worker of workers) {
      const staked = decodeUint256(
        await rpc.call({
          to: WORKER_REGISTRY_ADDRESS,
          data: encodeCall('getWorkerStake(address)', ['address'], [worker])
        })
      )
      console.log(`         ${worker}  staked ${lcai(staked)} LCAI`)
    }
  }
}
