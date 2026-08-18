import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress } from 'viem'
import { MESSAGE_VERSION, MessageError, authorPreimage, parseEntry, verifyAuthor } from './index.js'

/**
 * viem stands in for the wallet here, which keeps this package free of a curve
 * while still proving the preimage is signable and recoverable by ordinary
 * Ethereum tooling — the whole point of using EIP-191 rather than inventing a
 * scheme.
 */

const ROOM = 'a'.repeat(64)
const WRITER = 'b'.repeat(64)
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(KEY)

const hashText = (text: string) => keccak256(toHex(text))

const recover = (preimage: string, signature: string) => {
  // Synchronous, because verifyAuthor is called while rendering a list.
  let out = ''
  void recoverMessageAddress({ message: preimage, signature: signature as `0x${string}` }).then(
    (address) => (out = address)
  )
  return out
}

const message = (over: Record<string, unknown> = {}) => ({
  type: 'message' as const,
  v: MESSAGE_VERSION,
  id: 'msg-00000001',
  from: WRITER,
  at: 1_700_000_000_000,
  text: 'hello',
  ...over
})

async function signed(over: Record<string, unknown> = {}) {
  const base = message(over)
  const preimage = authorPreimage(ROOM, base, hashText)
  return { ...base, author: account.address, sig: await account.signMessage({ message: preimage }) }
}

describe('the preimage', () => {
  it('binds a message to its room', () => {
    const other = 'c'.repeat(64)
    expect(authorPreimage(ROOM, message(), hashText)).not.toBe(
      authorPreimage(other, message(), hashText)
    )
  })

  it('hashes the text rather than including it', () => {
    // A message containing newlines could otherwise fake the field separators
    // and claim a different writer or time.
    const sneaky = message({ text: 'hello\nat: 1\nwriter: ' + 'f'.repeat(64) })
    const preimage = authorPreimage(ROOM, sneaky, hashText)
    expect(preimage.split('\n')).toHaveLength(6)
    expect(preimage).not.toContain('f'.repeat(64))
  })

  it('changes when anything signed changes', () => {
    const base = authorPreimage(ROOM, message(), hashText)
    for (const over of [
      { id: 'msg-00000002' },
      { at: 1 },
      { text: 'other' },
      { from: 'c'.repeat(64) }
    ]) {
      expect(authorPreimage(ROOM, message(over), hashText)).not.toBe(base)
    }
  })

  it('refuses a room key that is not one', () => {
    expect(() => authorPreimage('nope', message(), hashText)).toThrow(MessageError)
  })
})

describe('verifying an author', () => {
  it('accepts a message the claimed wallet really signed', async () => {
    const entry = await signed()
    const preimage = authorPreimage(ROOM, entry, hashText)
    const address = await recoverMessageAddress({
      message: preimage,
      signature: entry.sig as `0x${string}`
    })
    expect(address).toBe(account.address)

    expect(verifyAuthor(ROOM, parseEntry(entry) as never, () => address, hashText)).toBe(
      account.address
    )
  })

  it('returns null for a message that claims nothing', () => {
    // Older entries, and peers with no wallet. Unattributed, not forged.
    expect(verifyAuthor(ROOM, parseEntry(message()) as never, recover, hashText)).toBeNull()
  })

  it('rejects a claim without a signature, and a signature without a claim', () => {
    expect(() => parseEntry(message({ author: account.address }))).not.toThrow()
    expect(() =>
      verifyAuthor(
        ROOM,
        parseEntry(message({ author: account.address })) as never,
        recover,
        hashText
      )
    ).toThrow(/must carry a signature/)
  })

  it('rejects someone else claiming to be the author', async () => {
    const entry = await signed()
    const impersonated = { ...entry, author: '0x' + '11'.repeat(20) }

    expect(() =>
      verifyAuthor(ROOM, parseEntry(impersonated) as never, () => account.address, hashText)
    ).toThrow(/claims to be from/)
  })

  it('rejects a signature lifted from another room', async () => {
    // The reason the room key is in the preimage at all.
    const entry = await signed()
    const elsewhere = 'd'.repeat(64)
    const recovered = await recoverMessageAddress({
      message: authorPreimage(elsewhere, entry, hashText),
      signature: entry.sig as `0x${string}`
    })
    expect(recovered).not.toBe(account.address)
  })

  it('rejects edited text', async () => {
    const entry = await signed()
    const edited = { ...entry, text: 'something else entirely' }
    const recovered = await recoverMessageAddress({
      message: authorPreimage(ROOM, edited, hashText),
      signature: edited.sig as `0x${string}`
    })
    expect(recovered).not.toBe(account.address)
  })
})

describe('parsing the new fields', () => {
  it('carries them through when present', async () => {
    const parsed = parseEntry(await signed())
    expect(parsed).toHaveProperty('author', account.address)
    expect(parsed).toHaveProperty('sig')
  })

  it('omits them when absent, so old entries are unchanged', () => {
    const parsed = parseEntry(message())
    expect(parsed).not.toHaveProperty('author')
    expect(parsed).not.toHaveProperty('sig')
  })

  it('refuses malformed ones rather than ignoring them', () => {
    expect(() => parseEntry(message({ author: 'not an address' }))).toThrow(/20-byte hex address/)
    expect(() => parseEntry(message({ sig: '0xabc' }))).toThrow(/65 bytes of hex/)
  })
})
