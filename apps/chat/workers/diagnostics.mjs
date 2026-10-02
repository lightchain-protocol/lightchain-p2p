/**
 * Crash and log diagnostics: how a broken machine explains itself.
 *
 * Until now the app had no answer to "it crashed" — the worker's output was
 * forwarded to the main process's stdout, which for an installed GUI app goes
 * nowhere, and no log file was ever written. Three things live here:
 *
 * - {@link createLogWriter}, a size-bounded rotating log. The Electron main
 *   process tees the worker's stdout/stderr and its own warnings into it, so
 *   the failure survives the crash that caused it.
 * - {@link zipStored} and {@link crc32}, a minimal uncompressed ZIP writer,
 *   because the export has to be one file and there is no archive library in
 *   this dependency tree.
 * - {@link exportDiagnostics}, the worker side of the `diagnostics.export`
 *   request, which packs everything safe to share into that ZIP.
 *
 * ## The privacy rule
 *
 * The log and the export exist to be handed to somebody helping with a broken
 * machine, so the rule is absolute: **nothing secret is ever written.** No
 * keys, no seed phrases, no keystore passwords, no message or transcript
 * contents. The rule is enforced by what is included — an explicit list, named
 * below and in the export itself — never by trying to recognise secrets after
 * the fact.
 *
 * ## Runtime portability
 *
 * This file is imported by two runtimes: the Electron main process (Node) for
 * the log writer, and the worker (Bare) for the export. Nothing is imported
 * statically from either, so the tests can run it under plain Node; the worker
 * side resolves its `fs`/`path`/`os` lazily through {@link defaultIo}, and the
 * tests inject their own.
 */

/** The base name of the log files, shared by the writer and the exporter. */
export const LOG_BASE_NAME = 'lightchain'

/** One file this size, plus this many numbered rotations of it. */
export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_BACKUPS = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The `fs`, `path` and `os` of whichever runtime loaded this file.
 *
 * Resolved on first use rather than at import time: the Electron main process
 * passes its own modules in and never pays for this, and under Node (the
 * tests) the `bare-*` specifiers do not resolve at all.
 */
async function defaultIo() {
  if (typeof globalThis.Bare !== 'undefined') {
    const [fs, path, os] = await Promise.all([
      import('bare-fs'),
      import('bare-path'),
      import('bare-os')
    ])
    return { fs: fs.default ?? fs, path: path.default ?? path, os: os.default ?? os }
  }

  const [fs, path, os] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:os')
  ])
  return { fs, path, os }
}

/**
 * A timestamped, size-bounded rotating log.
 *
 * `write(text, tag)` accepts arbitrary chunks — several lines, or half of one —
 * because what is teed into it is a byte stream, not a queue of messages.
 * Complete lines are written as `<iso time> [<tag>] <line>`; a trailing partial
 * line is held until its newline arrives or `flush()` is called.
 *
 * Rotation is the simplest correct kind: when appending a line would grow the
 * current file past `maxBytes`, the current file becomes `.log.1`, a `.log.1`
 * becomes `.log.2`, and so on up to `backups`, and the oldest is deleted. A
 * single line longer than `maxBytes` is written whole rather than mangled —
 * the bound is on the log's appetite, not on one line's length.
 *
 * Writes are synchronous, deliberately. This log exists to record crashes, and
 * a buffered writer loses exactly the lines that explain one.
 */
export function createLogWriter({
  fs,
  path,
  dir,
  baseName = LOG_BASE_NAME,
  maxBytes = LOG_MAX_BYTES,
  backups = LOG_BACKUPS,
  now = () => new Date()
}) {
  let carried = ''
  let madeDir = false

  const current = () => path.join(dir, `${baseName}.log`)

  function sizeOf(file) {
    try {
      return fs.statSync(file).size
    } catch {
      return 0
    }
  }

  function rotate() {
    try {
      fs.rmSync(path.join(dir, `${baseName}.log.${backups}`))
    } catch {
      // Nothing that old yet, which is the usual case.
    }
    for (let i = backups - 1; i >= 1; i--) {
      try {
        fs.renameSync(
          path.join(dir, `${baseName}.log.${i}`),
          path.join(dir, `${baseName}.log.${i + 1}`)
        )
      } catch {
        // A gap in the sequence is not a reason to stop rotating.
      }
    }
    try {
      fs.renameSync(current(), path.join(dir, `${baseName}.log.1`))
    } catch {
      // The current file did not exist; the append below creates it.
    }
  }

  function append(line) {
    if (!madeDir) {
      fs.mkdirSync(dir, { recursive: true })
      madeDir = true
    }

    const bytes = encoder.encode(line).length
    const size = sizeOf(current())
    if (size > 0 && size + bytes > maxBytes) rotate()

    fs.appendFileSync(current(), line, 'utf8')
  }

  return {
    file: current,
    write(text, tag = 'main') {
      carried += String(text)

      let end = carried.indexOf('\n')
      while (end !== -1) {
        const line = carried.slice(0, end).replace(/\r$/, '')
        carried = carried.slice(end + 1)
        append(`${now().toISOString()} [${tag}] ${line}\n`)
        end = carried.indexOf('\n')
      }
    },
    /** Writes out a held partial line, e.g. on the way down. */
    flush(tag = 'main') {
      if (carried === '') return
      const line = carried
      carried = ''
      append(`${now().toISOString()} [${tag}] ${line}\n`)
    }
  }
}

/**
 * CRC-32 (the ZIP polynomial), table-driven.
 *
 * The table is built once per process rather than shipped as 256 constants;
 * the arithmetic is the definition, so there is nothing to transcribe wrongly.
 */
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

export function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A Date as the DOS timestamp the ZIP format stamps entries with. */
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/**
 * A ZIP archive of the given entries, stored uncompressed.
 *
 * Uncompressed because it is portable and honest: the payload is a bounded set
 * of text logs (two megabytes at most, by the log writer's own cap), and a
 * `store`-only writer is a few dozen lines with no dependency and no runtime
 * surprises under Bare. Entries are `{ name, data }` with `/` separators in
 * the name, as the format expects.
 *
 * Written by hand because there is no archive library anywhere in this
 * dependency tree, and adding one to hold two log files would be the tail
 * wagging the dog.
 */
export function zipStored(entries, { now = () => new Date() } = {}) {
  const chunks = []
  const central = []
  let offset = 0
  const { time, day } = dosTime(now())

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name)
    const crc = crc32(data)

    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true) // local file header
    header.setUint16(4, 20, true) // version needed
    header.setUint16(6, 0x0800, true) // UTF-8 names
    header.setUint16(8, 0, true) // stored
    header.setUint16(10, time, true)
    header.setUint16(12, day, true)
    header.setUint32(14, crc, true)
    header.setUint32(18, data.length, true)
    header.setUint32(22, data.length, true)
    header.setUint16(26, nameBytes.length, true)
    header.setUint16(28, 0, true) // no extra field

    chunks.push(new Uint8Array(header.buffer), nameBytes, data)

    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true) // central directory header
    record.setUint16(4, 20, true) // version made by
    record.setUint16(6, 20, true) // version needed
    record.setUint16(8, 0x0800, true)
    record.setUint16(10, 0, true)
    record.setUint16(12, time, true)
    record.setUint16(14, day, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, data.length, true)
    record.setUint32(24, data.length, true)
    record.setUint16(28, nameBytes.length, true)
    // extra field length, comment length, disk numbers, attributes: all zero
    record.setUint32(42, offset, true) // where the local header sits
    central.push(new Uint8Array(record.buffer), nameBytes)

    offset += 30 + nameBytes.length + data.length
  }

  let centralSize = 0
  for (const chunk of central) centralSize += chunk.length

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const chunk of [...chunks, ...central, new Uint8Array(end.buffer)]) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A file beside this module, as a plain filesystem path on any platform. */
function moduleSibling(name) {
  const url = new URL(name, import.meta.url)
  let pathname = decodeURIComponent(url.pathname)
  // Windows URLs arrive as `/C:/...`; the drive letter wants no leading slash.
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
  return pathname
}

/**
 * The log files the writer can have produced, oldest last.
 *
 * Read from the directory rather than reconstructed from `backups`, because a
 * log that has never rotated has no `.1` and a crashed app may have left the
 * directory in any state — what is there is what is included.
 */
function logFiles(fs, path, logsDir) {
  let names
  try {
    names = fs.readdirSync(logsDir)
  } catch {
    return []
  }

  const ours = (name) =>
    name === `${LOG_BASE_NAME}.log` || new RegExp(`^${LOG_BASE_NAME}\\.log\\.[0-9]+$`).test(name)

  return names
    .filter(ours)
    .sort((a, b) =>
      a === `${LOG_BASE_NAME}.log` ? -1 : b === `${LOG_BASE_NAME}.log` ? 1 : a.localeCompare(b)
    )
    .map((name) => ({ name, file: path.join(logsDir, name) }))
}

/**
 * The `diagnostics.export` handler: everything safe to share, in one ZIP.
 *
 * What is included is enumerated, not filtered — the list below *is* the whole
 * archive, and anything not named here is not in it:
 *
 * - `report.txt` — generated: app version, platform and arch, the configured
 *   network, the storage layout, and the *names and sizes* of any crash dumps
 *   on disk. Dump contents are memory images and can hold anything the process
 *   held, keys included, so they are listed and never copied.
 * - `logs/lightchain.log` and its numbered rotations, if present.
 * - `preflight.json` — the `worker.doctor` probe summary, reached through
 *   `ctx.handle` rather than re-wired here. Absent when the check cannot run,
 *   with the reason noted in the report.
 *
 * Everything else on disk is excluded by never being read: the vault, the
 * swarm key, keystores, `settings.json` (it can hold the keystore password),
 * the sealed room registries, transcripts, local state, hosted rooms,
 * attachments, both corestores, and crash dump contents.
 *
 * The reply is `{ name, bytes }`, matching the attachment flow: the renderer
 * hands it to the existing `app:saveFile` dialog, so the person chooses where
 * it lands and the worker never learns a path.
 */
export async function exportDiagnostics(ctx, io = null) {
  const runtime = io ?? (await defaultIo())
  const { fs, path, os } = runtime

  const rootDir = path.dirname(ctx.chatDir)
  const logsDir = path.join(rootDir, 'logs')
  const crashesDir = path.join(rootDir, 'crashes')

  let productName = 'Lightchain'
  let version = 'unknown'
  try {
    const pkg = JSON.parse(decoder.decode(fs.readFileSync(moduleSibling('../package.json'))))
    productName = pkg.productName ?? pkg.name ?? productName
    version = pkg.version ?? version
  } catch {
    // The name and version are a courtesy in the report, not a reason to fail it.
  }

  // The names and sizes of crash dumps only. A minidump is an image of process
  // memory and may contain keys, so its contents never leave the machine.
  const dumps = []
  try {
    for (const name of fs.readdirSync(crashesDir)) {
      try {
        const stat = fs.statSync(path.join(crashesDir, name))
        if (stat.isFile()) dumps.push({ name, size: stat.size })
      } catch {
        // A file that vanished mid-listing is skipped.
      }
    }
  } catch {
    // No crashes directory, which is the happy case.
  }

  // The preflight probe summary, reused through the existing handler rather
  // than wired a second time. It reports addresses and hardware facts, never
  // secrets — the same reply the Worker page already draws.
  let preflight = null
  let preflightNote = 'skipped: the doctor handler is not reachable from here'
  if (typeof ctx.handle === 'function') {
    try {
      preflight = await ctx.handle({ t: 'worker.doctor' })
      preflightNote = 'included as preflight.json'
    } catch (err) {
      preflightNote = `skipped: the doctor check failed (${String(err?.message ?? err)})`
    }
  }

  const logs = logFiles(fs, path, logsDir)
  const release = typeof os.release === 'function' ? ` ${os.release()}` : ''

  const report = [
    `${productName} diagnostics - ${new Date().toISOString()}`,
    ``,
    `version:  ${version}`,
    `platform: ${os.platform()} ${os.arch()}${release}`,
    `network:  ${typeof ctx.network === 'function' ? ctx.network() : 'unknown'}`,
    `storage:  ${rootDir}`,
    ``,
    `logs included (${logs.length}):`,
    ...(logs.length === 0
      ? ['  (none - the log directory is absent or empty)']
      : logs.map(({ name, file }) => `  logs/${name} (${sizeOfFor(fs, file)} bytes)`)),
    ``,
    `crash dumps on disk (${dumps.length}) - names and sizes only; contents are`,
    `memory images and are never included:`,
    ...(dumps.length === 0 ? ['  (none)'] : dumps.map((d) => `  ${d.name} (${d.size} bytes)`)),
    ``,
    `preflight probe summary: ${preflightNote}`,
    ``,
    `Not included, ever: the vault, the swarm key, any keystore, settings.json`,
    `(it can hold the keystore password), the sealed room registries,`,
    `transcripts, local state, hosted rooms, attachments, message contents of`,
    `any kind, and crash dump contents.`,
    ``
  ].join('\n')

  const entries = [{ name: 'report.txt', data: encoder.encode(report) }]
  for (const { name, file } of logs) {
    try {
      entries.push({ name: `logs/${name}`, data: new Uint8Array(fs.readFileSync(file)) })
    } catch {
      // Rotated out from under us; the report already says what was seen.
    }
  }
  if (preflight !== null) {
    entries.push({
      name: 'preflight.json',
      data: encoder.encode(
        JSON.stringify(
          preflight,
          (key, value) => (typeof value === 'bigint' ? value.toString() : value),
          2
        )
      )
    })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  const bytes = zipStored(entries)
  // A plain array, matching how attachment bytes cross this pipe: the framed
  // JSON envelope has no binary type.
  return { name: `${LOG_BASE_NAME}-diagnostics-${stamp}.zip`, bytes: [...bytes] }
}

function sizeOfFor(fs, file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
