import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { passwordPath, readPasswordFile, writePasswordFile } from '../lib/password.mjs'

let keysDir

beforeEach(() => {
  keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcai-keys-'))
})

afterEach(() => {
  fs.rmSync(keysDir, { recursive: true, force: true })
})

describe('the keystore password file', () => {
  it('reads back what was written', () => {
    writePasswordFile(keysDir, 'correct-horse-battery-staple')
    expect(readPasswordFile(keysDir)).toBe('correct-horse-battery-staple')
  })

  it('is null when there is no file, rather than throwing', () => {
    expect(readPasswordFile(keysDir)).toBeNull()
  })

  it('is null when the directory does not exist either', () => {
    expect(readPasswordFile(path.join(keysDir, 'nope', 'still-nope'))).toBeNull()
  })

  it('creates the directory if it is not there yet', () => {
    const fresh = path.join(keysDir, 'made', 'on', 'demand')
    writePasswordFile(fresh, 'password')
    expect(readPasswordFile(fresh)).toBe('password')
  })

  // An operator who writes this file with a text editor gets a trailing newline
  // whether they want one or not, and a password wrong by one invisible byte
  // fails at registration with nothing to suggest why.
  it.each([
    ['a trailing newline', 'password\n'],
    ['a trailing CRLF', 'password\r\n']
  ])('ignores %s', (_label, written) => {
    fs.writeFileSync(passwordPath(keysDir), written)
    expect(readPasswordFile(keysDir)).toBe('password')
  })

  // Only the last one, so a password that genuinely ends in whitespace is still
  // usable and this does not quietly become a trim().
  it('keeps everything else exactly, including inner and leading spaces', () => {
    writePasswordFile(keysDir, '  two words  ')
    expect(readPasswordFile(keysDir)).toBe('  two words  ')
  })

  it('treats an empty file as no password rather than an empty one', () => {
    fs.writeFileSync(passwordPath(keysDir), '')
    expect(readPasswordFile(keysDir)).toBeNull()
  })

  it('replaces a password that is already there', () => {
    writePasswordFile(keysDir, 'first')
    writePasswordFile(keysDir, 'second')
    expect(readPasswordFile(keysDir)).toBe('second')
  })

  // The whole point of the file over the environment variable. Windows uses
  // ACLs and ignores the mode, so asserting there would be asserting a
  // protection that is not in place.
  it.runIf(process.platform !== 'win32')('is readable only by its owner', () => {
    writePasswordFile(keysDir, 'password')
    const mode = fs.statSync(passwordPath(keysDir)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  // `mode` is ignored for a file that already exists, so a password written
  // over a world-readable file would silently stay world-readable.
  it.runIf(process.platform !== 'win32')('narrows a file that was already too open', () => {
    fs.writeFileSync(passwordPath(keysDir), 'first', { mode: 0o644 })
    writePasswordFile(keysDir, 'second')
    expect(fs.statSync(passwordPath(keysDir)).mode & 0o777).toBe(0o600)
  })
})
