import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { createTestNetwork, type Peer, type TestNetwork } from '@lcai-p2p/testkit'
import {
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  parseEntry,
  type Attachment
} from '@lcai-p2p/protocol'
import { AttachmentError, Attachments, safeName, sniff } from './attachments.js'

let net: TestNetwork | undefined
const opened: Attachments[] = []

afterEach(async () => {
  for (const a of opened.splice(0)) await a.close().catch(() => undefined)
  await net?.destroy()
  net = undefined
})

/**
 * Stands in for a room: one key that may be announced, and one that may not.
 *
 * The swarm topic is derived from the public key rather than being the
 * encryption key itself, which is the same discipline a real room keeps.
 * Announcing a topic publishes it to the DHT, so a topic that was the
 * encryption key would hand the room's secret to anybody who looked.
 */
const ROOM_KEY = '11'.repeat(32)
const ROOM_ENCRYPTION_KEY = '22'.repeat(32)
const TOPIC = crypto.discoveryKey(b4a.from(ROOM_KEY, 'hex'))

async function openAttachments(
  peer: Peer,
  encryptionKey = ROOM_ENCRYPTION_KEY,
  namespace?: string
): Promise<Attachments> {
  const attachments = await Attachments.open({ store: peer.store, encryptionKey, namespace })
  opened.push(attachments)
  peer.swarm.on('connection', (socket) => attachments.replicate(socket))
  peer.swarm.join(TOPIC, { server: true, client: true })
  return attachments
}

/** ASCII, so the signatures below read as the four-character codes they are. */
const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0))
const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values)

const PNG = bytesOf(0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0x00)
const GIF87A = bytesOf(...ascii('GIF87a'), 1, 0, 1, 0)
const GIF89A = bytesOf(...ascii('GIF89a'), 1, 0, 1, 0)
const WEBP = bytesOf(...ascii('RIFF'), 0x1a, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '))
/** A RIFF container that is not a WebP. The first four bytes are identical. */
const WAV = bytesOf(...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE'), ...ascii('fmt '))
const SVG = b4a.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/")</script></svg>'
)

describe('a file put beside a message', () => {
  it('comes back byte for byte', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const bytes = b4a.from('the quiet part, in a file', 'utf8')
    const attachment = await attachments.put(bytes, { name: 'notes.txt', type: 'text/plain' })

    expect(attachment.name).toBe('notes.txt')
    expect(attachment.type).toBe('text/plain')
    expect(attachment.size).toBe(bytes.byteLength)
    expect(attachment.core).toMatch(/^[0-9a-f]{64}$/)
    expect(attachment.hash).toMatch(/^0x[0-9a-f]{64}$/)

    expect(b4a.equals(await attachments.get(attachment), bytes)).toBe(true)
  })

  it('addresses a file that spans several blocks', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const bytes = crypto.randomBytes(200_000)
    const attachment = await attachments.put(bytes, { name: 'noise.bin' })

    expect(attachment.size).toBe(bytes.byteLength)
    expect(attachment.blob.blockLength).toBeGreaterThan(1)

    // Worth pinning, because it is not obvious and the opposite would be easy
    // to assume: the core stores eight bytes of encryption padding per block,
    // and Hypercore takes that back off before reporting a byte length, so the
    // address describes the file rather than what sits on the disk. `size` is
    // recorded from the input regardless — it is the number the cap is applied
    // to and it must not depend on how the bytes happened to be stored.
    expect(attachment.blob.byteLength).toBe(attachment.size)
    expect(b4a.equals(await attachments.get(attachment), bytes)).toBe(true)
  })

  it('produces a reference the protocol will carry', async () => {
    // The reference goes into an entry that is signed and replicated forever,
    // so a shape the protocol's own parser rejects would be a file that could
    // be written and never sent.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(PNG, { name: 'tiny.png', type: 'image/png' })

    expect(
      parseEntry({
        type: 'message',
        v: 1,
        id: 'attachment-001',
        from: '33'.repeat(32),
        at: Date.now(),
        text: 'here you go',
        attachment
      })
    ).toMatchObject({ attachment })
  })

  it('normalises a media type it will not be able to carry, rather than refusing to send', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const unlabelled = await attachments.put(PNG, { name: 'a.bin' })
    expect(unlabelled.type).toBe('application/octet-stream')

    const parameterised = await attachments.put(PNG, {
      name: 'b.txt',
      type: 'Text/Plain; charset=utf-8'
    })
    expect(parameterised.type).toBe('text/plain')

    const nonsense = await attachments.put(PNG, { name: 'c.bin', type: 'not a media type' })
    expect(nonsense.type).toBe('application/octet-stream')
  })

  it('refuses a name it cannot record', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    await expect(attachments.put(PNG, { name: '   ' })).rejects.toThrow(AttachmentError)
    await expect(
      attachments.put(PNG, { name: 'x'.repeat(MAX_ATTACHMENT_NAME_LENGTH + 1) })
    ).rejects.toThrow(/255 characters/)
  })
})

describe('the digest is the only reason to believe a reference', () => {
  it('refuses bytes that do not hash to what the message says', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(b4a.from('the real file'), { name: 'real.txt' })
    const tampered: Attachment = { ...attachment, hash: `0x${'ab'.repeat(32)}` }

    await expect(attachments.get(tampered)).rejects.toThrow(/does not hash/)
  })

  it('refuses a reference that points at somebody else’s bytes', async () => {
    // The substitution the digest exists to catch. Both files are the same
    // length, so the cheap check passes and only the hash is left to notice
    // that the blob at this address is a different file entirely.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const invoice = await attachments.put(b4a.from('pay 10 to alice'), { name: 'invoice.txt' })
    const forgery = await attachments.put(b4a.from('pay 99 to trudy'), { name: 'invoice.txt' })
    expect(invoice.size).toBe(forgery.size)

    const swapped: Attachment = { ...invoice, blob: forgery.blob }
    await expect(attachments.get(swapped)).rejects.toThrow(/does not hash/)

    // And the untouched reference still resolves, which is what makes the
    // rejection above mean something.
    expect(b4a.toString(await attachments.get(invoice))).toBe('pay 10 to alice')
  })

  it('refuses a blob whose length is not the length the message declared', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const short = await attachments.put(b4a.from('short'), { name: 'short.txt' })
    const long = await attachments.put(b4a.from('rather longer than that'), { name: 'long.txt' })

    await expect(attachments.get({ ...short, blob: long.blob })).rejects.toThrow(
      /declares 5 bytes and the blob holds 23/
    )
  })
})

describe('limits, on the way in and on the way out', () => {
  it('refuses a file past the cap rather than writing it', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    await expect(
      attachments.put(new Uint8Array(MAX_ATTACHMENT_SIZE + 1), { name: 'huge.bin' })
    ).rejects.toThrow(AttachmentError)
  })

  it('refuses to fetch a blob that declares more than the cap', async () => {
    // The declared size arrives from a stranger, so the cap has to be applied
    // to what is claimed before any bandwidth is spent on it, and not only to
    // what this peer chooses to send.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(b4a.from('small'), { name: 'small.txt' })

    await expect(attachments.get({ ...attachment, size: MAX_ATTACHMENT_SIZE + 1 })).rejects.toThrow(
      /past the/
    )
  })

  it('refuses a blob spanning more blocks than an attachment could', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(b4a.from('small'), { name: 'small.txt' })
    const absurd: Attachment = {
      ...attachment,
      blob: { ...attachment.blob, blockLength: 50_000_000 }
    }

    await expect(attachments.get(absurd)).rejects.toThrow(/blocks/)
  })

  it('refuses a reference that is not shaped like one', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(b4a.from('small'), { name: 'small.txt' })

    await expect(attachments.get({ ...attachment, hash: 'nope' })).rejects.toThrow(/hash/)
    await expect(attachments.get({ ...attachment, core: 'nope' })).rejects.toThrow(/core/)
    await expect(attachments.get({ ...attachment, size: -1 })).rejects.toThrow(/size/)
  })

  it('refuses an encryption key that is not one', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    await expect(Attachments.open({ store: alice.store, encryptionKey: 'nope' })).rejects.toThrow(
      /encryption key/
    )
  })
})

describe('a second peer', () => {
  it('fetches a file over the swarm and proves it is the right one', async () => {
    // The point of the whole arrangement: the bytes are not in the log, so a
    // reader has to be able to go and get them from a core it has only ever
    // seen the key of.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const hers = await openAttachments(alice)
    const his = await openAttachments(bob)
    await net.connect()

    const bytes = crypto.randomBytes(150_000)
    const attachment = await hers.put(bytes, { name: 'photo.png', type: 'image/png' })

    expect(attachment.core).toBe(hers.key)
    expect(attachment.core).not.toBe(his.key)

    expect(b4a.equals(await his.get(attachment), bytes)).toBe(true)
  })

  it('hands back nothing to a peer holding the wrong encryption key', async () => {
    // Replicating a room must not mean being able to read it, and that has to
    // hold for the files as much as for the messages. Eve can pull the blocks
    // down — that is what replication is — and what she gets out of them is not
    // the file, so the digest refuses it rather than handing her plausible
    // rubbish labelled as a photograph.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const eve = await net.createPeer('eve')

    const hers = await openAttachments(alice)
    const withoutTheKey = await openAttachments(eve, '99'.repeat(32))
    await net.connect()

    const attachment = await hers.put(b4a.from('something private'), { name: 'private.txt' })

    // Specifically the digest, and not a timeout: the blocks reach her, they
    // decrypt to the wrong thing under the wrong key, and that is what is
    // caught.
    await expect(withoutTheKey.get(attachment, { timeout: 10_000 })).rejects.toThrow(
      /does not hash/
    )
  })
})

describe('what is written to disk', () => {
  it('does not contain the file in the clear', async () => {
    // The room is encrypted so that the peers replicating it cannot read it. An
    // attachment core left in the clear beside it would give back everything
    // that encryption was for. Asserting an absence is only worth anything
    // beside a control, so this also checks the scan can find what it should.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    const attachments = await Attachments.open({
      store: alice.store,
      encryptionKey: ROOM_ENCRYPTION_KEY
    })
    const secret = b4a.from('the quiet part, in a file')
    await attachments.put(secret, { name: 'notes.txt' })
    const coreKey = attachments.key
    await attachments.close()

    // Closed before reading: an open Corestore holds its files.
    await alice.goOffline()

    const files = await readdir(alice.dir, { recursive: true, withFileTypes: true })
    let sawSecret = false
    let sawCoreKey = false

    for (const entry of files) {
      if (!entry.isFile()) continue
      const bytes = await readFile(join(entry.parentPath, entry.name))
      if (bytes.includes(Buffer.from(secret))) sawSecret = true
      if (bytes.includes(Buffer.from(coreKey, 'hex'))) sawCoreKey = true
    }

    // Core keys are not secret and are stored as they are, so finding one
    // proves the scan is capable of finding a byte sequence at all.
    expect(sawCoreKey).toBe(true)
    expect(sawSecret).toBe(false)
  })
})

describe('what a file actually is', () => {
  it('recognises the formats worth rendering inline', () => {
    expect(sniff(PNG)).toBe('image/png')
    expect(sniff(JPEG)).toBe('image/jpeg')
    expect(sniff(GIF87A)).toBe('image/gif')
    expect(sniff(GIF89A)).toBe('image/gif')
    expect(sniff(WEBP)).toBe('image/webp')
  })

  it('says unknown rather than guessing', () => {
    expect(sniff(WAV)).toBe('unknown')
    expect(sniff(b4a.from('just some text'))).toBe('unknown')
    expect(sniff(bytesOf())).toBe('unknown')
    // A header cut short is exactly the case where a sniffer that reached past
    // the end of the buffer would compare against undefined and agree.
    expect(sniff(PNG.subarray(0, 4))).toBe('unknown')
    expect(sniff(bytesOf(...ascii('RIFF')))).toBe('unknown')
  })

  it('is not swayed by a PNG that arrives labelled as text', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(PNG, { name: 'notes.txt', type: 'text/plain' })
    expect(attachment.type).toBe('text/plain')

    // The claim survives into the message, because that is what the sender
    // said. It is simply not what anybody renders on.
    expect(sniff(await attachments.get(attachment))).toBe('image/png')
  })

  it('never calls an SVG an image, however it is labelled', async () => {
    // An SVG is XML that can carry script, and this runs in Electron. Treating
    // one as an image means letting somebody in a chat room run code, so it has
    // to fall out of sniffing as a file to download and nothing else.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const attachments = await openAttachments(alice)

    const attachment = await attachments.put(SVG, { name: 'logo.svg', type: 'image/svg+xml' })
    expect(attachment.type).toBe('image/svg+xml')

    expect(sniff(await attachments.get(attachment))).toBe('unknown')
    expect(sniff(SVG)).toBe('unknown')
    expect(sniff(b4a.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('unknown')
  })
})

describe('making a filename safe to save', () => {
  it('keeps only the last segment of a path', () => {
    expect(safeName('..\\..\\Windows\\System32\\evil.exe')).toBe('evil.exe')
    expect(safeName('../../../etc/passwd')).toBe('passwd')
    expect(safeName('C:\\Users\\someone\\evil.exe')).toBe('evil.exe')
    expect(safeName('/etc/shadow')).toBe('shadow')
    // Drive-relative, and the one with no separator in it at all: `C:evil.exe`
    // means "in whatever the current directory on C: happens to be".
    expect(safeName('C:evil.exe')).toBe('evil.exe')
  })

  it('strips control characters', () => {
    expect(safeName('re\u0000port.pdf')).toBe('report.pdf')
    expect(safeName('two\nlines.txt')).toBe('twolines.txt')
    expect(safeName('esc\u001bape\u007f.txt')).toBe('escape.txt')
  })

  it('strips leading dots, and the trailing dots and spaces Windows discards', () => {
    expect(safeName('.hidden')).toBe('hidden')
    expect(safeName('...hidden')).toBe('hidden')
    expect(safeName('evil.exe.')).toBe('evil.exe')
    expect(safeName('evil.exe ')).toBe('evil.exe')
    expect(safeName('evil.exe. . .')).toBe('evil.exe')
    expect(safeName('  spaced.txt  ')).toBe('spaced.txt')
  })

  it('strips the characters a save would be rejected for', () => {
    // What is left of a colon is an NTFS alternate data stream: the bytes would
    // go into a second, invisible file beside the one that was named.
    expect(safeName('notes.txt:hidden.exe')).toBe('notes.txthidden.exe')
    expect(safeName('a<b>c"d|e?f*g.txt')).toBe('abcdefg.txt')
  })

  it('renames the Windows device names, which are hardware rather than files', () => {
    for (const device of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
      expect(safeName(device)).toBe(`_${device}`)
    }

    // With an extension and in any casing, they are still the device.
    expect(safeName('con.txt')).toBe('_con.txt')
    expect(safeName('Com1.jpg')).toBe('_Com1.jpg')
    expect(safeName('nul.tar.gz')).toBe('_nul.tar.gz')
    expect(safeName('..\\..\\CON')).toBe('_CON')

    // COM0 and LPT10 are not devices, and renaming them would be superstition.
    expect(safeName('COM0.txt')).toBe('COM0.txt')
    expect(safeName('LPT10.txt')).toBe('LPT10.txt')
    expect(safeName('console.log')).toBe('console.log')
  })

  it('never returns an empty string, whatever it is given', () => {
    // Every rule above can consume its whole input, and an empty filename in a
    // save dialog is either an error at the worst moment or a path that
    // resolves to the directory itself.
    for (const name of ['', '   ', '.', '..', '...', '\\', '/', 'C:', '\u0000', '. . .', '<>|']) {
      expect(safeName(name)).not.toBe('')
    }
    expect(safeName('..')).toBe('attachment')
    expect(safeName('..\\..\\')).toBe('attachment')
  })

  it('never returns a name longer than a filesystem will take', () => {
    expect(safeName('x'.repeat(400))).toHaveLength(MAX_ATTACHMENT_NAME_LENGTH)
    expect(safeName(`${'x'.repeat(300)}.txt`)).toHaveLength(MAX_ATTACHMENT_NAME_LENGTH)
    expect(safeName(`${'x'.repeat(254)}..`)).toHaveLength(254)
  })
})
