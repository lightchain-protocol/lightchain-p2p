import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import b4a from 'b4a'
import type Corestore from 'corestore'
import {
  MANIFEST_PATH,
  MANIFEST_VERSION,
  assertModelRef,
  encodeManifest,
  parseManifest,
  type ModelFileEntry,
  type ModelManifest,
  type ModelRef
} from '@lcai-p2p/protocol'

/**
 * A model published as a Hyperdrive.
 *
 * This package deliberately does **not** own a Hyperswarm. It takes a Corestore
 * and nothing else, so the same code is testable against a local DHT, usable
 * from a Bare worker, and never decides on the caller's behalf whether to
 * announce something to the network. Joining a topic is the application's call;
 * `discoveryKey` is exposed for it.
 */

/** Gap between version checks while waiting for a peer to supply a model. */
const POLL_INTERVAL_MS = 100

export class ModelDriveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelDriveError'
  }
}

export interface PublishOptions {
  readonly store: Corestore
  /** Local directory containing the model files. */
  readonly source: string
  /** Everything in the manifest except the parts derived from the drive itself. */
  readonly manifest: Omit<ModelManifest, 'manifestVersion' | 'files'>
  /** Assign roles by path, e.g. `/model.gguf` to `weights`. */
  readonly roles?: Readonly<Record<string, string>>
}

export interface OpenOptions {
  readonly store: Corestore
  readonly ref: ModelRef
  /** How long to wait for peers to supply the pinned version. */
  readonly timeout?: number
}

export interface ReadRange {
  /** Byte offset within the file. */
  readonly start?: number
  /** Number of bytes. Preferred over an end offset, which Hyperdrive treats as inclusive. */
  readonly length?: number
}

export class ModelDrive {
  readonly #drive: Hyperdrive
  readonly #snapshot: Hyperdrive
  readonly #ref: ModelRef
  #manifest: ModelManifest | undefined

  private constructor(drive: Hyperdrive, snapshot: Hyperdrive, ref: ModelRef) {
    this.#drive = drive
    this.#snapshot = snapshot
    this.#ref = ref
  }

  /**
   * Publishes a directory as a model drive and returns it pinned at the version
   * that was just written.
   */
  static async publish(opts: PublishOptions): Promise<ModelDrive> {
    // A namespaced session matters more than it looks: Hyperdrive.close() calls
    // corestore.close(), and on a root store that tears down every other core
    // the caller had open. A session with a root closes only itself.
    const store = opts.store.namespace(`model:${opts.manifest.name}`)
    const drive = new Hyperdrive(store)
    await drive.ready()

    const local = new Localdrive(opts.source)
    try {
      await local.mirror(drive).done()
    } finally {
      await local.close()
    }

    // The manifest is built from what actually landed in the drive rather than
    // from the source directory, so it cannot drift from the content it
    // describes.
    const files = await collectFiles(drive, opts.roles ?? {})
    if (files.length === 0) {
      throw new ModelDriveError(
        `no files found under "${opts.source}" - refusing to publish an empty model`
      )
    }

    const manifest: ModelManifest = {
      manifestVersion: MANIFEST_VERSION,
      name: opts.manifest.name,
      files,
      description: opts.manifest.description,
      license: opts.manifest.license,
      runtime: opts.manifest.runtime,
      quantization: opts.manifest.quantization,
      publishedAt: opts.manifest.publishedAt ?? Date.now()
    }

    await drive.put(MANIFEST_PATH, b4a.from(encodeManifest(manifest)))

    // Force the blobs core open before anyone replicates. Corestore only offers
    // cores it has loaded, so a drive whose blobs were never opened replicates
    // its metadata and none of its content.
    await drive.getBlobs()

    const ref = assertModelRef({ key: b4a.toString(drive.key, 'hex'), version: drive.version })
    const model = new ModelDrive(drive, drive.checkout(ref.version), ref)
    model.#manifest = manifest
    return model
  }

  /**
   * Opens a published model at its pinned version.
   *
   * Waits for peers to supply the metadata, because a drive opened by key starts
   * empty and reports version 1 whether the content is missing or genuinely that
   * short.
   */
  static async open(opts: OpenOptions): Promise<ModelDrive> {
    const ref = assertModelRef(opts.ref)
    const store = opts.store.namespace(`model:${ref.key}`)
    const drive = new Hyperdrive(store, b4a.from(ref.key, 'hex'))
    await drive.ready()

    const deadline = Date.now() + (opts.timeout ?? 30_000)
    while (drive.version < ref.version) {
      if (Date.now() > deadline) {
        await drive.close()
        throw new ModelDriveError(
          `timed out waiting for ${ref.key}@${ref.version}; reached version ${drive.version}. ` +
            'Either no peer is serving this model or the reference names content that was never published.'
        )
      }
      // Sleep first, unconditionally. With no peers connected update() resolves
      // immediately, so any loop that only awaits it spins as fast as the event
      // loop allows and exhausts the heap in seconds rather than timing out.
      await sleep(POLL_INTERVAL_MS)
      // Blocks replicate into the core on their own once a peer is connected;
      // this only nudges the check, so it must not wait.
      await drive.update({ wait: false }).catch(() => false)
    }

    // Only now: the blobs core is named in the drive header, which does not
    // exist locally until the metadata above has replicated.
    await drive.getBlobs()

    return new ModelDrive(drive, drive.checkout(ref.version), ref)
  }

  get ref(): ModelRef {
    return this.#ref
  }

  /** Topic to join on Hyperswarm to find or serve this model. */
  get discoveryKey(): Buffer {
    return this.#drive.discoveryKey
  }

  get writable(): boolean {
    return this.#drive.writable
  }

  async manifest(): Promise<ModelManifest> {
    if (this.#manifest) return this.#manifest
    const raw = await this.#snapshot.get(MANIFEST_PATH)
    if (!raw) {
      throw new ModelDriveError(
        `no manifest at ${MANIFEST_PATH} in ${this.#ref.key}@${this.#ref.version} - not a model drive`
      )
    }
    this.#manifest = parseManifest(raw)
    return this.#manifest
  }

  /**
   * Reads a byte range of a file without fetching the rest of it.
   *
   * This is the point of putting weights in a Hyperdrive: a runtime can pull the
   * part of a multi-gigabyte file it needs now.
   */
  async readRange(path: string, range: ReadRange = {}): Promise<Uint8Array> {
    // Checked up front so a missing file is named. Streaming it instead raises
    // a bare "Blob does not exist" with no indication of which path or model.
    const entry = await this.#snapshot.entry(path)
    if (!entry) {
      throw new ModelDriveError(
        `no such file in model ${this.#ref.key}@${this.#ref.version}: ${path}`
      )
    }

    const chunks: Uint8Array[] = []
    // Hyperdrive's `end` is inclusive, which is an easy off-by-one. Only
    // `start`/`length` are exposed here so callers cannot meet it.
    for await (const chunk of this.#snapshot.createReadStream(path, {
      start: range.start,
      length: range.length
    })) {
      chunks.push(chunk)
    }
    return b4a.concat(chunks)
  }

  /**
   * Fetches every block so this peer can serve the model to others.
   *
   * Reading on demand caches only what was read. A peer that has streamed part
   * of a model cannot serve the whole of it, which is the difference between a
   * cache and a replica.
   */
  async replicateFully(): Promise<void> {
    await this.#snapshot.download('/').done()
  }

  async close(): Promise<void> {
    // The snapshot shares blobs with its parent, so it must go first; closing
    // the parent takes the namespace session with it.
    await this.#snapshot.close()
    await this.#drive.close()
  }
}

async function collectFiles(
  drive: Hyperdrive,
  roles: Readonly<Record<string, string>>
): Promise<ModelFileEntry[]> {
  const files: ModelFileEntry[] = []
  for await (const entry of drive.list('/', { recursive: true })) {
    if (entry.key === MANIFEST_PATH) continue
    const role = roles[entry.key]
    files.push({
      path: entry.key,
      bytes: entry.value.blob?.byteLength ?? 0,
      ...(role === undefined ? {} : { role })
    })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
