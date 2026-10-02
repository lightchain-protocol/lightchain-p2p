/**
 * Which models this worker offers, and pulling one down.
 */

import { hasModel, probeDisk, probeGpu, probeMemory, probeOllama } from '@lcai-p2p/host'
import { fits } from '@lcai-p2p/preflight'

import { resolveAddresses } from '@lcai-p2p/chain'

import { footprintsFor } from '../../services/model-footprints.mjs'
import { modelFee } from '../ai.mjs'

export function workerModelHandlers(ctx, kit) {
  const { rpc, workerConfig, network, chainId, setting } = ctx
  const { withBusy, offeredModels, fetchOne } = kit

  /**
   * What the settings say this worker declares, read without `resolveConfig`.
   *
   * The fallback for when the configuration will not resolve: the choice is
   * still worth showing, because it is usually the thing that needs changing.
   */
  function declaredModels() {
    const raw = setting('supportedModels', 'SUPPORTED_MODELS')
    return raw
      ? raw
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m !== '')
      : []
  }

  return {
    /**
     * Which models this network whitelists, which of them this machine already
     * holds, and which this worker has chosen to serve.
     *
     * The list is the network's and is read live. Mainnet has gone from two
     * models to seven without this application changing, governance will move
     * it again, and a list compiled into this build would be wrong the first
     * time it did — so nothing here names a model, and the panel renders
     * whatever comes back.
     *
     * `models` is null rather than empty when the network could not be asked.
     * An empty whitelist and an unreachable service are very different facts
     * and must not render the same way: one is "there is nothing to run here",
     * the other is "we do not know yet".
     */
    'worker.models': async () => {
      const { config, problem } = workerConfig({ keystorePassword: 'unset' })

      // A configuration this cannot resolve must not take the model list down
      // with it. It used to: `models: null` rendered as "Not configured", and
      // since the list is also the only way to change the choice, a single
      // rejected name left the panel with no way back. The network's list
      // needs no configuration beyond which network — so when the config is
      // unusable, fall back to the selected network and still render it.
      const selected = config?.network ?? network()
      if (!selected) {
        return { configured: false, problem, network: null, models: null, chosen: [] }
      }

      const [offered, ollama, addresses, gpu, disk] = await Promise.all([
        offeredModels(config ?? { network: selected, chainId: chainId() }).catch(() => null),
        probeOllama(),
        // Fees are priced from the chain rather than from the service, so what
        // is shown is what the contract will pay. A node that will not answer
        // costs the prices, not the list.
        resolveAddresses(rpc()).catch(() => null),
        probeGpu().catch(() => undefined),
        probeDisk().catch(() => undefined)
      ])

      const tags = ollama.models ?? []
      const chosen = new Set(config?.supportedModels ?? [])

      // What this machine has to offer, for the verdict on each row. A unified
      // GPU reports no discrete VRAM because there is none — the pool is the
      // system's, so that is what a model has to fit inside.
      const machine = {
        availableVramBytes: gpu?.unifiedMemory
          ? (gpu.vramBytes ?? probeMemory()?.totalBytes)
          : gpu?.vramBytes,
        freeDiskBytes: disk?.freeBytes
      }

      const footprints =
        offered === null ? new Map() : await footprintsFor(offered.map((m) => m.name))

      const models =
        offered === null
          ? null
          : await Promise.all(
              offered.map(async (model) => {
                const footprint = footprints.get(model.name)
                const verdict = footprint ? fits(footprint, machine) : null
                return {
                  name: model.name,
                  id: model.id,
                  chosen: chosen.has(model.name),
                  // Against the network's name, never the reference it was pulled
                  // under — that difference is the whole failure this guards.
                  installed: hasModel(tags, model.name),
                  fee: addresses
                    ? await modelFee(rpc(), addresses.aiConfig, model.id)
                        .then((wei) => wei.toString())
                        .catch(() => null)
                    : null,
                  // What it costs this machine, so the answer arrives before
                  // the tick rather than after the download.
                  weightsBytes: footprint?.weightsBytes ?? null,
                  minVramBytes: footprint?.minVramBytes ?? null,
                  sizeKnown: footprint !== undefined && footprint.source !== 'unknown',
                  fits: verdict?.ok ?? true,
                  fitsNote: verdict?.reason ?? null
                }
              })
            )

      return {
        configured: config !== null,
        problem: config ? null : problem,
        network: selected,
        models,
        machine,
        // What the worker declares today, which can include a name the network
        // has since dropped — worth showing rather than silently omitting.
        chosen: [...(config?.supportedModels ?? declaredModels())]
      }
    },

    /**
     * The models, fetched — the phase of the published guide that is pure
     * terminal and has no business being.
     *
     * Takes the names to fetch, falling back to whatever the worker declares.
     * Needs no key, no stake and no gateway: what models a machine holds is a
     * fact about the machine, so this is not gated on hosting being available.
     */
    'worker.fetchModel': async (req) => {
      const { config } = workerConfig({ keystorePassword: 'unset' })

      const asked = Array.isArray(req.models)
        ? req.models.filter((name) => typeof name === 'string' && name !== '')
        : []
      // Falling back through the settings as well as the config: fetching is a
      // fact about this machine and needs no resolved configuration, so a
      // config that will not resolve must not also block the download.
      const models = asked.length > 0 ? asked : [...(config?.supportedModels ?? declaredModels())]

      if (models.length === 0) {
        throw new Error(
          'no models to fetch - choose which of the ones this network whitelists this machine should answer for'
        )
      }

      return withBusy('fetching models', async () => {
        const fetched = []
        for (const name of models) fetched.push({ name, reference: await fetchOne(name) })
        return { ok: true, models: fetched }
      })
    }
  }
}
