/**
 * The model manifest.
 *
 * Stored as a JSON file inside the model's Hyperdrive rather than encoded into a
 * Hypercore block. Two reasons: it is a file among other files, so Hyperdrive
 * already gives it content addressing and range reads; and an operator debugging
 * a bad publish can read it with `cat`, which matters more than the bytes saved
 * by a compact encoding on a document this small next to multi-gigabyte weights.
 *
 * ## This format is permanent
 *
 * A published manifest is replicated and signed forever and cannot be migrated.
 * The rule from CONTRIBUTING applies in full:
 *
 * - Add optional fields. Never remove one, never rename one, never change a type.
 * - Parsing **ignores unknown fields** rather than rejecting them, so an older
 *   reader keeps working against a newer publisher. Dropping that property is
 *   the one change here that would break the network rather than a build.
 */

/** Path of the manifest inside a model drive. */
export const MANIFEST_PATH = '/manifest.json'

/** Current manifest version. Increment only for a breaking change, which should never happen. */
export const MANIFEST_VERSION = 1

/**
 * What a file is for. Open by design: an unrecognised role must not fail a
 * parse, because runtimes we do not know about yet will need their own.
 */
export type ModelFileRole = 'weights' | 'tokenizer' | 'template' | 'config' | (string & {})

export interface ModelFileEntry {
  /** Absolute path within the drive, e.g. `/model.gguf`. */
  readonly path: string
  /** Size in bytes. Lets a consumer plan a range read before fetching anything. */
  readonly bytes: number
  readonly role?: ModelFileRole
}

export interface ModelManifest {
  readonly manifestVersion: number
  /** Human-readable name. Not an identifier — the ModelRef is the identifier. */
  readonly name: string
  readonly files: readonly ModelFileEntry[]
  readonly description?: string
  readonly license?: string
  /** Unix milliseconds. */
  readonly publishedAt?: number
  /** Intended runtime, e.g. `ollama`. Advisory only. */
  readonly runtime?: string
  /** e.g. `Q4_K_M`. Advisory only. */
  readonly quantization?: string
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field)
}

function parseFile(value: unknown, index: number): ModelFileEntry {
  if (!isRecord(value)) throw new ManifestError(`files[${index}] must be an object`)

  const path = requireString(value.path, `files[${index}].path`)
  if (!path.startsWith('/')) {
    throw new ManifestError(`files[${index}].path must be absolute within the drive, got "${path}"`)
  }

  const bytes = value.bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ManifestError(`files[${index}].bytes must be a non-negative integer`)
  }

  const role = optionalString(value.role, `files[${index}].role`)
  return role === undefined ? { path, bytes } : { path, bytes, role }
}

/**
 * Parses and validates a manifest.
 *
 * Unknown fields are ignored rather than rejected. That is deliberate: it is
 * what lets a field added next year reach a client shipped today without
 * breaking it.
 */
export function parseManifest(input: string | Uint8Array): ModelManifest {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input)

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ManifestError(`manifest is not valid JSON: ${(err as Error).message}`)
  }

  if (!isRecord(raw)) throw new ManifestError('manifest must be a JSON object')

  const manifestVersion = raw.manifestVersion
  if (
    typeof manifestVersion !== 'number' ||
    !Number.isSafeInteger(manifestVersion) ||
    manifestVersion < 1
  ) {
    throw new ManifestError('manifestVersion must be an integer of at least 1')
  }
  if (manifestVersion > MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest version ${manifestVersion} is newer than this build understands (${MANIFEST_VERSION}). Upgrade to read this model.`
    )
  }

  if (!Array.isArray(raw.files)) throw new ManifestError('files must be an array')
  const files = raw.files.map(parseFile)

  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.path)) throw new ManifestError(`duplicate file path "${file.path}"`)
    seen.add(file.path)
  }

  const publishedAt = raw.publishedAt
  if (
    publishedAt !== undefined &&
    (typeof publishedAt !== 'number' || !Number.isSafeInteger(publishedAt))
  ) {
    throw new ManifestError('publishedAt must be an integer of unix milliseconds')
  }

  return {
    manifestVersion,
    name: requireString(raw.name, 'name'),
    files,
    description: optionalString(raw.description, 'description'),
    license: optionalString(raw.license, 'license'),
    publishedAt,
    runtime: optionalString(raw.runtime, 'runtime'),
    quantization: optionalString(raw.quantization, 'quantization')
  }
}

/** Serialises a manifest. Stable key order so republishing identical input is a no-op. */
export function encodeManifest(manifest: ModelManifest): string {
  const ordered = {
    manifestVersion: manifest.manifestVersion,
    name: manifest.name,
    description: manifest.description,
    license: manifest.license,
    runtime: manifest.runtime,
    quantization: manifest.quantization,
    publishedAt: manifest.publishedAt,
    files: manifest.files.map((f) => ({ path: f.path, bytes: f.bytes, role: f.role }))
  }
  return (
    JSON.stringify(ordered, (_key, value) => (value === undefined ? undefined : value), 2) + '\n'
  )
}
