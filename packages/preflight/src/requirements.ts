/**
 * What a worker host must provide, before any particular model is chosen.
 *
 * Published in docs/running-a-worker.md and, until this package existed,
 * enforced nowhere: an operator below them discovered it as a container that
 * starts, takes a job, and fails at inference — a much worse place to find out
 * than before installation.
 *
 * These are a floor and not an answer. They describe running a worker at all;
 * what a *given* model needs is what its weights weigh, and the whitelist
 * spans 4 GB to 61 GB. `requirementsForModels` in ./sizing.ts raises these to
 * the chosen set, and nothing should check against the bare defaults once a
 * choice has been made.
 */

export const GIB = 1024 ** 3

export interface Requirements {
  /** Ollama needs room for the model plus context. */
  readonly minVramBytes: number
  readonly minFreeDiskBytes: number
  readonly minRamBytes: number
  /**
   * Model names as they appear in SUPPORTED_MODELS.
   *
   * Supplied by the caller from the worker's own configuration, which in turn
   * comes from what the network whitelists. Empty is a meaningful value — a
   * worker that has chosen no models — and is reported as such rather than
   * passing quietly.
   */
  readonly requiredModels: readonly string[]
  /** Host port Ollama listens on. */
  readonly ollamaPort: number
}

export const DEFAULT_REQUIREMENTS: Requirements = {
  minVramBytes: 8 * GIB,
  minFreeDiskBytes: 50 * GIB,
  minRamBytes: 16 * GIB,
  // No model is named here. Which models exist is the network's answer, and a
  // name compiled into a default is one that goes stale the first time
  // governance changes the whitelist.
  requiredModels: [],
  ollamaPort: 11434
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}
