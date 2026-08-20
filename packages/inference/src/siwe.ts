/**
 * Parsing a Sign-In-With-Ethereum (EIP-4361) challenge before it is signed.
 *
 * The challenge is composed by the service being signed in to, which is the
 * one party with something to gain by lying: a compromised or malicious
 * service that is handed an unsigned blank cheque can ask for an EIP-191
 * signature over any text at all — a login challenge for a different service,
 * an off-chain authorisation, anything `personal_sign` verifies against. The
 * only defence available here is to refuse to sign anything that is not a
 * well-formed challenge naming this service, this address, and this chain,
 * while its clock fields still hold.
 *
 * What cannot be checked here is the nonce's freshness: it is minted by the
 * service and redeemed against its own store, so its value is only ever
 * provable to the service. Presence is enforced because absence means the
 * message is not SIWE at all; correctness is the verify endpoint's job.
 */

export class SiweError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiweError'
  }
}

export interface SiweChallenge {
  readonly domain: string
  readonly address: string
  readonly statement: string | null
  readonly uri: string
  readonly version: string
  readonly chainId: bigint
  readonly nonce: string
  readonly issuedAt: string
  readonly expirationTime: string | null
  readonly notBefore: string | null
  /** The exact text that was parsed, for signing byte-for-byte. */
  readonly raw: string
}

export interface SiweExpectation {
  /** The address about to prove control of itself. */
  readonly address: string
  /**
   * The URL of the service being signed in to. The challenge's domain must be
   * its host and its URI must live on the same host — a challenge naming
   * anything else is a signature for somebody else's front door.
   */
  readonly url: string
  /**
   * The chain the caller believes the service anchors to. Optional only
   * because not every caller knows it; pass it wherever a network profile is
   * in hand, for the same reason `sendTransaction` takes one.
   */
  readonly chainId?: bigint
}

// The EIP-4361 layout, in the order viem's createSiweMessage — which is what
// composes these on the service — writes it. Every field the scheme makes
// mandatory is mandatory here too: a message that omits one does not parse,
// and what does not parse does not get signed.
//
// The statement is the subtle line, because the two composers in the wild
// disagree about it. viem writes `address\n\n URI:` when there is none; the
// Spruce library — which the live service uses — still writes both
// separators, giving `address\n\n\n URI:`. With a statement both write
// `address\n\n statement\n\n URI:`. An optional statement line followed by an
// optional extra blank accepts all three, and nothing that is not SIWE.
const SIWE = new RegExp(
  '^' +
    '(?<domain>[^\\n]+) wants you to sign in with your Ethereum account:\\n' +
    '(?<address>0x[0-9a-fA-F]{40})\\n\\n' +
    '((?<statement>[^\\n]+)\\n)?\\n?' +
    'URI: (?<uri>[^\\n]+)\\n' +
    'Version: (?<version>[^\\n]+)\\n' +
    'Chain ID: (?<chainId>[0-9]+)\\n' +
    'Nonce: (?<nonce>[^\\s]+)\\n' +
    'Issued At: (?<issuedAt>[^\\n]+)' +
    '(\\nExpiration Time: (?<expirationTime>[^\\n]+))?' +
    '(\\nNot Before: (?<notBefore>[^\\n]+))?' +
    '(\\nRequest ID: [^\\n]+)?' +
    '(\\nResources:(\\n- [^\\n]+)+)?' +
    '$'
)

export function parseSiweChallenge(message: string): SiweChallenge {
  const match = SIWE.exec(message)
  if (!match?.groups) {
    throw new SiweError(
      'the service offered something that is not a sign-in-with-ethereum message. Signing it would hand over an EIP-191 signature over arbitrary text, so nothing was signed.'
    )
  }

  const groups = match.groups
  return {
    domain: groups.domain as string,
    address: groups.address as string,
    statement: groups.statement ?? null,
    uri: groups.uri as string,
    version: groups.version as string,
    chainId: BigInt(groups.chainId as string),
    nonce: groups.nonce as string,
    issuedAt: groups.issuedAt as string,
    expirationTime: groups.expirationTime ?? null,
    notBefore: groups.notBefore ?? null,
    raw: message
  }
}

/** A clock field is RFC 3339; a date that does not parse is not a date. */
function timestamp(value: string, field: string): number {
  const millis = Date.parse(value)
  if (Number.isNaN(millis)) {
    throw new SiweError(`the challenge's ${field} is not a timestamp: ${JSON.stringify(value)}`)
  }
  return millis
}

/**
 * Checks a challenge against what the caller believes, and refuses — loudly,
 * before anything is signed — when the two disagree.
 *
 * Refusal is the only move available. There is no adjusting a challenge into
 * line: the signature covers the text exactly as offered, so a field that is
 * wrong is a signature over the wrong claim, and the fix belongs to whoever
 * composed it.
 */
export function checkSiweChallenge(message: string, expectation: SiweExpectation): SiweChallenge {
  const challenge = parseSiweChallenge(message)

  const host = new URL(expectation.url).host
  if (challenge.domain !== host) {
    throw new SiweError(
      `the challenge is for ${JSON.stringify(challenge.domain)}, but this service is ${JSON.stringify(host)}. Signing it would prove control of the address to a different service. Nothing was signed.`
    )
  }

  // Compared case-insensitively: checksumming is a display convention, and an
  // all-lowercase challenge is the same account.
  if (challenge.address.toLowerCase() !== expectation.address.toLowerCase()) {
    throw new SiweError(
      `the challenge is addressed to ${challenge.address}, not to ${expectation.address}. Nothing was signed.`
    )
  }

  let uri: URL
  try {
    uri = new URL(challenge.uri)
  } catch {
    throw new SiweError(`the challenge's URI is not one: ${JSON.stringify(challenge.uri)}`)
  }
  if (uri.host !== challenge.domain) {
    throw new SiweError(
      `the challenge's URI is on ${JSON.stringify(uri.host)} but its domain is ${JSON.stringify(challenge.domain)} — the two name different services. Nothing was signed.`
    )
  }

  if (challenge.version !== '1') {
    throw new SiweError(`the challenge is SIWE version ${challenge.version}; only 1 is understood`)
  }

  if (expectation.chainId !== undefined && challenge.chainId !== expectation.chainId) {
    throw new SiweError(
      `the challenge is for chain ${challenge.chainId}, but this network is chain ${expectation.chainId}. Nothing was signed.`
    )
  }

  timestamp(challenge.issuedAt, 'Issued At')

  if (challenge.expirationTime !== null) {
    const expires = timestamp(challenge.expirationTime, 'Expiration Time')
    if (expires <= Date.now()) {
      throw new SiweError(
        `the challenge expired at ${challenge.expirationTime}. Signing a stale challenge proves nothing the service will accept, so nothing was signed.`
      )
    }
  }

  if (challenge.notBefore !== null) {
    const validFrom = timestamp(challenge.notBefore, 'Not Before')
    if (validFrom > Date.now()) {
      throw new SiweError(
        `the challenge is not valid until ${challenge.notBefore}. Nothing was signed.`
      )
    }
  }

  return challenge
}
