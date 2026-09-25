/**
 * What each model costs this machine, measured once and remembered.
 *
 * The Earn panel refreshes on a timer and every refresh renders the whole
 * model list, so measuring on each pass would put a registry round-trip per
 * model behind a UI tick. Weights for a published tag do not change, so a
 * successful measurement is kept for the life of the process.
 *
 * A failed one is not. Offline is a temporary fact and caching it would leave
 * the panel saying "size unknown" long after the network came back, so those
 * are retried after a short pause.
 */

import fetch from '#fetch'
import { fetchFootprint } from '@lcai-p2p/preflight'
import { modelCandidates } from '@lcai-p2p/host'

/** How long before an unmeasurable model is worth asking about again. */
const RETRY_UNKNOWN_MS = 60_000

const measured = new Map()
const failedAt = new Map()

/**
 * Footprints for these names, as a Map keyed by the network's exact name.
 *
 * Never throws and never rejects: a size that could not be read is reported
 * as `source: 'unknown'`, which the checks and the picker both handle. A
 * panel that cannot render because a registry was slow is a worse outcome
 * than a panel that admits it does not know one number.
 */
export async function footprintsFor(names) {
  const wanted = [...new Set(names)].filter((name) => typeof name === 'string' && name !== '')

  await Promise.all(
    wanted.map(async (name) => {
      const hit = measured.get(name)
      if (hit && hit.source !== 'unknown') return

      const failed = failedAt.get(name)
      if (hit && failed !== undefined && Date.now() - failed < RETRY_UNKNOWN_MS) return

      try {
        const footprint = await fetchFootprint(name, modelCandidates(name), fetch)
        measured.set(name, footprint)
        if (footprint.source === 'unknown') failedAt.set(name, Date.now())
        else failedAt.delete(name)
      } catch {
        measured.set(name, {
          name,
          weightsBytes: 0,
          minVramBytes: 0,
          diskBytes: 0,
          source: 'unknown'
        })
        failedAt.set(name, Date.now())
      }
    })
  )

  return new Map(
    wanted.map((name) => [name, measured.get(name)]).filter(([, v]) => v !== undefined)
  )
}
