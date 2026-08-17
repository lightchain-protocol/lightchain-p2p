/**
 * Finding the keystore inside the mounted data directory.
 *
 * `WORKER_KEYSTORE_PATH` must point at the keystore *file*, not the directory,
 * and the file is named by go-ethereum with a UTC timestamp and the address. The
 * toolkit interpolates it in shell with a glob, which quietly picks the wrong
 * one when a second key has been imported — and a worker running under an
 * unexpected address looks like it is working until rewards go somewhere else.
 */

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeystoreError'
  }
}

/** go-ethereum names keystore files `UTC--<timestamp>--<address>`. */
const KEYSTORE_FILE = /^UTC--.+--[0-9a-fA-F]{40}$/

export interface KeystoreSelection {
  readonly file: string
  /** Lowercase hex, no 0x prefix, as it appears in the filename. */
  readonly address: string
}

/**
 * Picks the single keystore from a directory listing.
 *
 * Refuses to guess when there is more than one. Choosing arbitrarily would run
 * the worker under an address the operator did not intend, and the symptom is
 * silent: it registers, takes jobs, and earns to the wrong account.
 */
export function selectKeystore(
  names: readonly string[],
  expectedAddress?: string
): KeystoreSelection {
  const candidates = names.filter((name) => KEYSTORE_FILE.test(name))

  if (candidates.length === 0) {
    throw new KeystoreError(
      'no keystore file found. Import a key first; the keystore is created inside the data directory as UTC--<timestamp>--<address>.'
    )
  }

  if (expectedAddress) {
    const wanted = expectedAddress.replace(/^0x/, '').toLowerCase()
    const match = candidates.find((name) => name.toLowerCase().endsWith(wanted))
    if (!match) {
      throw new KeystoreError(
        `no keystore for address 0x${wanted}. Found: ${candidates
          .map(addressOf)
          .map((a) => `0x${a}`)
          .join(', ')}`
      )
    }
    return { file: match, address: addressOf(match) }
  }

  if (candidates.length > 1) {
    throw new KeystoreError(
      `${candidates.length} keystores present and no address given, so which key the worker would run as is ambiguous: ${candidates
        .map(addressOf)
        .map((a) => `0x${a}`)
        .join(', ')}. Pass the address explicitly.`
    )
  }

  return { file: candidates[0]!, address: addressOf(candidates[0]!) }
}

function addressOf(name: string): string {
  return name.slice(-40).toLowerCase()
}

/** Path of the keystore as the container sees it. */
export function containerKeystorePath(file: string): string {
  return `/data/eth-keystore/${file}`
}
