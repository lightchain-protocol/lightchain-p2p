/**
 * What a worker host must provide.
 *
 * These numbers are published in the worker toolkit's hardware table but are not
 * enforced anywhere in it. An operator below them discovers it as a container
 * that starts, takes a job, and fails at inference — which is a much worse place
 * to find out than before installation.
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
