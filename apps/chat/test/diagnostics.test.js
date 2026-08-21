import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOG_MAX_BYTES,
  createLogWriter,
  crc32,
  exportDiagnostics,
  zipStored
} from '../workers/diagnostics.mjs'

/**
 * The crash-diagnostics half of the app that runs without Electron.
 *
 * Three rules matter here more than any feature: the log cannot grow without
 * bound, the ZIP it exports is a real ZIP, and the export can never contain
 * a secret — which is checked by building a storage directory full of secrets
 * and reading back everything the exporter produced.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-diagnostics-'))
}

/** A clock that ticks once per call, so timestamps are distinct and ordered. */
function clock(start = Date.UTC(2026, 7, 15, 12, 0, 0)) {
  let at = start
  return () => new Date(at++)
}

/** Reads back the ZIPs zipStored writes: stored entries only, which is all it makes. */
function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Map()

  let off = 0
  while (view.getUint32(off, true) === 0x04034b50) {
    const method = view.getUint16(off + 8, true)
    const size = view.getUint32(off + 18, true)
    const nameLength = view.getUint16(off + 26, true)
    const extraLength = view.getUint16(off + 28, true)
    const name = decoder.decode(bytes.subarray(off + 30, off + 30 + nameLength))
    const data = bytes.subarray(
      off + 30 + nameLength + extraLength,
      off + 30 + nameLength + extraLength + size
    )

    expect(method).toBe(0)
    out.set(name, data)
    off += 30 + nameLength + extraLength + size
  }

  // The local headers are followed by the central directory, and the archive
  // ends with the end-of-central-directory record.
  expect(view.getUint32(off, true)).toBe(0x02014b50)
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)

  return out
}

describe('log writer', () => {
  it('writes timestamped, tagged lines', () => {
    const dir = tmpdir()
    const writer = createLogWriter({ fs, path, dir, now: clock() })

    writer.write('worker said hello\nsecond line\n', 'worker:out')

    const text = fs.readFileSync(path.join(dir, 'lightchain.log'), 'utf8')
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[worker:out\] worker said hello$/
    )
    expect(lines[1]).toMatch(/\[worker:out\] second line$/)
  })

  it('holds a partial line until its newline arrives', () => {
    const dir = tmpdir()
    const writer = createLogWriter({ fs, path, dir, now: clock() })

    writer.write('half a', 'worker:err')
    expect(fs.existsSync(path.join(dir, 'lightchain.log'))).toBe(false)

    writer.write(' line\n', 'worker:err')
    const text = fs.readFileSync(path.join(dir, 'lightchain.log'), 'utf8')
    expect(text).toMatch(/\[worker:err\] half a line\n$/)

    // And flush writes out whatever is still held, e.g. on the way down.
    writer.write('unfinished')
    writer.flush('main')
    expect(fs.readFileSync(path.join(dir, 'lightchain.log'), 'utf8')).toMatch(
      /\[main\] unfinished\n$/
    )
  })

  it('rotates at the size bound and never grows past current + backups', () => {
    const dir = tmpdir()
    const maxBytes = 400
    const writer = createLogWriter({ fs, path, dir, maxBytes, backups: 1, now: clock() })

    // Far more than two files' worth of lines.
    for (let i = 0; i < 60; i++) writer.write(`line number ${i} of the log\n`, 'worker:out')

    const names = fs.readdirSync(dir).sort()
    expect(names).toEqual(['lightchain.log', 'lightchain.log.1'])

    // Each file stays within the bound plus one line (a line is never split
    // across files, so a line that crosses the bound lands whole).
    const longestLine = 60
    for (const name of names) {
      expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(maxBytes + longestLine)
    }

    // The recent lines are in the current file; the one before it holds the
    // lines rotated out, and nothing older survives anywhere.
    const current = fs.readFileSync(path.join(dir, 'lightchain.log'), 'utf8')
    const backup = fs.readFileSync(path.join(dir, 'lightchain.log.1'), 'utf8')
    expect(current).toContain('line number 59 of the log')
    expect(backup).not.toContain('line number 59 of the log')
    expect(current + backup).not.toContain('line number 0 of the log')
  })

  it('defaults to one file of 1 MB with a single backup', () => {
    expect(LOG_MAX_BYTES).toBe(1024 * 1024)
  })
})

describe('crc32', () => {
  it('matches the published check value', () => {
    // The standard CRC-32 test vector.
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('zipStored', () => {
  it('writes an archive whose entries read back byte for byte', () => {
    const bytes = zipStored([
      { name: 'report.txt', data: encoder.encode('the report') },
      { name: 'logs/lightchain.log', data: encoder.encode('line one\nline two\n') },
      { name: 'empty.txt', data: new Uint8Array(0) }
    ])

    const entries = unzipStored(bytes)
    expect([...entries.keys()].sort()).toEqual(['empty.txt', 'logs/lightchain.log', 'report.txt'])
    expect(decoder.decode(entries.get('report.txt'))).toBe('the report')
    expect(decoder.decode(entries.get('logs/lightchain.log'))).toBe('line one\nline two\n')
    expect(entries.get('empty.txt').length).toBe(0)
  })
})

describe('diagnostics export', () => {
  /**
   * A storage directory holding every kind of secret the app keeps, so the
   * test fails the moment any of them leaks into the export.
   */
  function storageWithSecrets() {
    const root = tmpdir()
    const chatDir = path.join(root, 'chat')
    fs.mkdirSync(chatDir, { recursive: true })

    fs.writeFileSync(path.join(chatDir, 'vault.json'), 'SECRET VAULT CONTENTS')
    fs.writeFileSync(path.join(chatDir, 'settings.json'), '{"workerPassword":"SECRET-PASSWORD"}')
    fs.writeFileSync(path.join(chatDir, 'swarm-key'), 'SECRET SWARM KEY')
    fs.writeFileSync(path.join(chatDir, 'rooms.abcd.sealed'), 'SECRET ROOM REGISTRY')
    fs.mkdirSync(path.join(chatDir, 'local'), { recursive: true })
    fs.writeFileSync(path.join(chatDir, 'local', 'unread.sealed'), 'SECRET LOCAL STATE')
    fs.mkdirSync(path.join(chatDir, 'corestore'), { recursive: true })
    fs.writeFileSync(path.join(chatDir, 'corestore', 'data'), 'TRANSCRIPT BYTES')

    const logsDir = path.join(root, 'logs')
    fs.mkdirSync(path.join(logsDir), { recursive: true })
    fs.writeFileSync(path.join(logsDir, 'lightchain.log'), 'recent log line\n')
    fs.writeFileSync(path.join(logsDir, 'lightchain.log.1'), 'rotated log line\n')
    // Not one of ours: the export names its logs rather than taking a directory.
    fs.writeFileSync(path.join(logsDir, 'stray.txt'), 'NOT A LOG')

    const crashesDir = path.join(root, 'crashes')
    fs.mkdirSync(path.join(crashesDir), { recursive: true })
    fs.writeFileSync(
      path.join(crashesDir, '01234567-89ab-cdef-0123-456789abcdef.dmp'),
      'DUMP BYTES'
    )

    return { root, chatDir }
  }

  it('packs exactly the enumerated include list and nothing secret', async () => {
    const { chatDir } = storageWithSecrets()
    const ctx = { chatDir, network: () => 'mainnet' }

    const res = await exportDiagnostics(ctx, { fs, path, os })

    expect(res.name).toMatch(/^lightchain-diagnostics-\d{4}-\d{2}-\d{2}\.zip$/)

    const entries = unzipStored(Uint8Array.from(res.bytes))
    // The include list, in full: the generated report and the log files. No
    // preflight.json — there is no doctor handler on this ctx — and nothing
    // else, whatever else the storage directory holds.
    expect([...entries.keys()].sort()).toEqual([
      'logs/lightchain.log',
      'logs/lightchain.log.1',
      'report.txt'
    ])

    expect(decoder.decode(entries.get('logs/lightchain.log'))).toBe('recent log line\n')
    expect(decoder.decode(entries.get('logs/lightchain.log.1'))).toBe('rotated log line\n')

    const report = decoder.decode(entries.get('report.txt'))
    expect(report).toContain('platform:')
    expect(report).toContain('network:  mainnet')
    // The crash dump is listed by name so a helper can ask for it explicitly…
    expect(report).toContain('01234567-89ab-cdef-0123-456789abcdef.dmp')

    // …and nothing secret is anywhere in the archive: not the vault, not the
    // password settings.json holds, not the swarm key, not transcripts, not
    // dump contents, and not the file that merely shared the logs directory.
    const everything = [...entries.values()].map((data) => decoder.decode(data)).join('\n')
    expect(everything).not.toContain('SECRET VAULT CONTENTS')
    expect(everything).not.toContain('SECRET-PASSWORD')
    expect(everything).not.toContain('SECRET SWARM KEY')
    expect(everything).not.toContain('SECRET ROOM REGISTRY')
    expect(everything).not.toContain('SECRET LOCAL STATE')
    expect(everything).not.toContain('TRANSCRIPT BYTES')
    expect(everything).not.toContain('DUMP BYTES')
    expect(everything).not.toContain('NOT A LOG')
  })

  it('still exports when there are no logs and no crashes at all', async () => {
    const root = tmpdir()
    const chatDir = path.join(root, 'chat')
    fs.mkdirSync(chatDir, { recursive: true })

    const res = await exportDiagnostics({ chatDir }, { fs, path, os })
    const entries = unzipStored(Uint8Array.from(res.bytes))

    expect([...entries.keys()]).toEqual(['report.txt'])
    const report = decoder.decode(entries.get('report.txt'))
    expect(report).toContain('logs included (0)')
    expect(report).toContain('crash dumps on disk (0)')
  })

  it('includes the doctor probe summary when the handler answers', async () => {
    const { chatDir } = storageWithSecrets()
    const ctx = {
      chatDir,
      network: () => 'testnet',
      handle: async (req) => {
        expect(req.t).toBe('worker.doctor')
        return { results: [{ id: 'docker', status: 'pass' }], totals: { pass: 1 } }
      }
    }

    const res = await exportDiagnostics(ctx, { fs, path, os })
    const entries = unzipStored(Uint8Array.from(res.bytes))

    const preflight = JSON.parse(decoder.decode(entries.get('preflight.json')))
    expect(preflight.totals.pass).toBe(1)
    expect(decoder.decode(entries.get('report.txt'))).toContain('included as preflight.json')
  })

  it('notes a failed doctor check in the report rather than failing the export', async () => {
    const { chatDir } = storageWithSecrets()
    const ctx = {
      chatDir,
      handle: async () => {
        throw new Error('docker exploded')
      }
    }

    const res = await exportDiagnostics(ctx, { fs, path, os })
    const entries = unzipStored(Uint8Array.from(res.bytes))

    expect(entries.has('preflight.json')).toBe(false)
    expect(decoder.decode(entries.get('report.txt'))).toContain(
      'skipped: the doctor check failed (docker exploded)'
    )
  })
})
