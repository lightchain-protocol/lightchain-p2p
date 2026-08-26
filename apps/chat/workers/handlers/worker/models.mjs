/**
 * Which models this worker offers, and pulling one down.
 */

import { hasModel, probeOllama } from '@lcai-p2p/host'

import { resolveAddresses } from '@lcai-p2p/chain'

import { modelFee } from '../ai.mjs'

export function workerModelHandlers(ctx, kit) {
  const { rpc, workerConfig } = ctx
  const { withBusy, offeredModels, fetchOne } = kit

  return {
    /**
     * Which models this network whitelists, which of them this machine already
     * holds, and which this worker has chosen to serve.
     *
     * The list is the network's and is read live. Mainnet whitelists one model
     * and devnet ten, governance changes both, and a list compiled into this
     * application would be wrong the first time it did — so nothing here names
     * a model, and the panel renders whatever comes back.
     *
     * `models` is null rather than empty when the network could not be asked.
     * An empty whitelist and an unreachable service are very different facts
     * and must not render the same way: one is "there is nothing to run here",
     * the other is "we do not know yet".
     */
    'worker.models': async () => {
      const { config, problem } = workerConfig({ keystorePassword: 'unset' })
      if (!config) return { configured: false, problem, network: null, models: null, chosen: [] }

      const [offered, ollama, addresses] = await Promise.all([
        offeredModels(config).catch(() => null),
        probeOllama(),
        // Fees are priced from the chain rather than from the service, so what
        // is shown is what the contract will pay. A node that will not answer
        // costs the prices, not the list.
        resolveAddresses(rpc()).catch(() => null)
      ])

      const tags = ollama.models ?? []
      const chosen = new Set(config.supportedModels)

      const models =
        offered === null
          ? null
          : await Promise.all(
              offered.map(async (model) => ({
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
                  : null
              }))
            )

      return {
        configured: true,
        network: config.network,
        models,
        // What the worker declares today, which can include a name the network
        // has since dropped — worth showing rather than silently omitting.
        chosen: [...config.supportedModels]
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
      const models = asked.length > 0 ? asked : [...(config?.supportedModels ?? [])]

      if (models.length === 0) {
        throw new Error(
          'no models to fetch — choose which of the ones this network whitelists this machine should answer for'
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
