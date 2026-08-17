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
  /** Model names as they appear in SUPPORTED_MODELS. */
  readonly requiredModels: readonly string[]
  /** Host port Ollama listens on. */
  readonly ollamaPort: number
}

export const DEFAULT_REQUIREMENTS: Requirements = {
  minVramBytes: 8 * GIB,
  minFreeDiskBytes: 50 * GIB,
  minRamBytes: 16 * GIB,
  requiredModels: ['llama3-8b'],
  ollamaPort: 11434
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}
