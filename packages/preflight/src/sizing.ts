/**
 * What one model costs the machine that serves it.
 *
 * The package's flat minimums answer "can this host run a worker at all". They
 * cannot answer "can this host run *this* model", and the difference is the
 * whole failure this exists for: `gpt-oss:120b` is 60.9 GB of weights against a
 * 50 GB disk minimum, so a checklist built on the flat number passes a machine
 * that cannot hold the download, let alone serve it.
 *
 * Sizes are measured from the registry rather than tabled here. A table would
 * be another copy of the network's answer, wrong the first time governance
 * whitelists something it does not list — the same reason nothing in this
 * codebase names a model. `estimateFootprint` is the floor for when the
 * registry cannot be reached, and it says that it is an estimate.
 */

import { GIB, type Requirements } from './requirements.js'

/** Weights must fit with room for the KV cache and the runtime's own overhead. */
const VRAM_HEADROOM = 1.2

/** Context and runtime working set, on top of the weights. */
const CONTEXT_RESERVE_BYTES = 1 * GIB

/**
 * Free space wanted beyond the weights themselves: the pull writes a temporary
 * blob before it lands, and a host with exactly zero bytes left is a host that
 * fails at something else shortly afterwards.
 */
const DISK_HEADROOM_BYTES = 10 * GIB

/**
 * Bytes per parameter at the quantisation Ollama publishes by default.
 *
 * Checked against the real manifests: 8b → 4.8 GB estimated vs 4.7 measured,
 * 20b → 12.0 vs 12.8, 70b → 42.0 vs 37.2, 120b → 72.0 vs 60.9. It runs a
 * little high on the largest models, which is the right direction for a
 * number that gates whether somebody downloads 60 GB.
 */
const BYTES_PER_PARAMETER = 0.6

/** A parameter count in a model name: the `20b` of `gpt-oss:20b`, `8b` of `llama3-8b`. */
const PARAMETERS = /(?:^|[-:])(\d+(?:\.\d+)?)b(?:$|[-:])/i

export interface ModelFootprint {
  /** The network's name, exactly as it spells it. */
  readonly name: string
  /** Weights as published, summed over the manifest's layers. */
  readonly weightsBytes: number
  /** What must be resident for inference to keep up with the job deadline. */
  readonly minVramBytes: number
  /** What a copy costs on disk. */
  readonly diskBytes: number
  /** Whether the weights were measured or inferred from the name. */
  readonly source: 'registry' | 'estimate' | 'unknown'
}

/** Minimal shape of the fetch this needs, so callers inject their runtime's. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function footprintFromWeights(
  name: string,
  weightsBytes: number,
  source: ModelFootprint['source']
): ModelFootprint {
  return {
    name,
    weightsBytes,
    minVramBytes: Math.round(weightsBytes * VRAM_HEADROOM + CONTEXT_RESERVE_BYTES),
    diskBytes: weightsBytes,
    source
  }
}

/**
 * A footprint from the name alone, for when the registry cannot be reached.
 *
 * Null when the name carries no parameter count — `qwen3-coder-next` says
 * nothing about its size, and inventing a number for it would be worse than
 * admitting the size is unknown.
 */
export function estimateFootprint(name: string): ModelFootprint | null {
  const match = PARAMETERS.exec(name)
  if (!match?.[1]) return null
  const billions = Number.parseFloat(match[1])
  if (!Number.isFinite(billions) || billions <= 0) return null
  return footprintFromWeights(name, billions * 1e9 * BYTES_PER_PARAMETER, 'estimate')
}

/**
 * Measures one model against the registry, falling back to the estimate.
 *
 * `references` are the registry names to try, in order — the same candidate
 * list the fetch itself walks, so what is measured is what would be pulled.
 * The first that resolves wins; a name nothing publishes falls through to the
 * estimate, and then to `unknown`.
 */
export async function fetchFootprint(
  name: string,
  references: readonly string[],
  fetchLike: FetchLike,
  registryBase = 'https://registry.ollama.ai/v2/library'
): Promise<ModelFootprint> {
  for (const reference of references) {
    const [repo, tag = 'latest'] = splitReference(reference)
    try {
      const res = await fetchLike(`${registryBase}/${repo}/manifests/${tag}`, {
        headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }
      })
      if (!res.ok) continue
      const body = (await res.json()) as { layers?: { size?: number }[] }
      const total = (body.layers ?? []).reduce((sum, layer) => sum + (layer.size ?? 0), 0)
      if (total > 0) return footprintFromWeights(name, total, 'registry')
    } catch {
      // Offline, blocked, or a registry that answered something unparseable.
      // The estimate below is the honest answer in all three cases.
      continue
    }
  }

  return (
    estimateFootprint(name) ?? {
      name,
      weightsBytes: 0,
      minVramBytes: 0,
      diskBytes: 0,
      source: 'unknown'
    }
  )
}

function splitReference(reference: string): [string, string?] {
  const cut = reference.indexOf(':')
  return cut === -1 ? [reference] : [reference.slice(0, cut), reference.slice(cut + 1)]
}

/**
 * The requirements for serving exactly this set of models.
 *
 * VRAM is the largest single model, because they are loaded one at a time —
 * a host that can serve the biggest can serve the rest. Disk is the sum,
 * because every chosen model is downloaded and kept.
 *
 * `ollama cp` writes a manifest pointing at the layers already pulled rather
 * than a second copy, so the alias the fetch creates costs nothing here and
 * is deliberately not counted twice.
 *
 * Models whose size is `unknown` contribute nothing and leave the package
 * floor in place: an unmeasurable model must not silently lower the bar.
 */
export function requirementsForModels(
  base: Requirements,
  footprints: readonly ModelFootprint[]
): Requirements {
  const known = footprints.filter((f) => f.source !== 'unknown')
  if (known.length === 0) return { ...base, requiredModels: footprints.map((f) => f.name) }

  const vram = Math.max(...known.map((f) => f.minVramBytes))
  const disk = known.reduce((sum, f) => sum + f.diskBytes, 0) + DISK_HEADROOM_BYTES

  return {
    ...base,
    // Never below the package floor: a 2 GB model still needs a machine that
    // can run a worker, a container runtime and the host beside it.
    minVramBytes: Math.max(base.minVramBytes, vram),
    minFreeDiskBytes: Math.max(base.minFreeDiskBytes, disk),
    minRamBytes: base.minRamBytes,
    requiredModels: footprints.map((f) => f.name)
  }
}

/**
 * Whether this machine can serve this model, for the row that offers it.
 *
 * Answered before the tick rather than after the download, which is the point.
 * `availableVramBytes` is discrete VRAM, or total system memory on a unified
 * Apple GPU where the two are the same pool.
 */
export function fits(
  footprint: ModelFootprint,
  machine: { availableVramBytes?: number; freeDiskBytes?: number }
): { ok: boolean; reason: string | null } {
  if (footprint.source === 'unknown') {
    return { ok: true, reason: 'size unknown — this machine may or may not hold it' }
  }
  if (
    machine.availableVramBytes !== undefined &&
    machine.availableVramBytes < footprint.minVramBytes
  ) {
    return { ok: false, reason: 'needs more memory than this machine has' }
  }
  if (machine.freeDiskBytes !== undefined && machine.freeDiskBytes < footprint.diskBytes) {
    return { ok: false, reason: 'the weights will not fit in free disk space' }
  }
  return { ok: true, reason: null }
}
