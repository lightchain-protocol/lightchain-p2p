import { describe, expect, it } from 'vitest'
import { safeFileName } from '../electron/safe-file-name.js'

const RTL_OVERRIDE = '\u202e'

describe('the name an attachment is saved under', () => {
  it('leaves an ordinary name alone', () => {
    expect(safeFileName('holiday.png')).toBe('holiday.png')
    expect(safeFileName('quarterly report (final).pdf')).toBe('quarterly report (final).pdf')
  })

  // The name came from whoever sent the file, so a save dialog pre-filled with
  // a path is a way to write somewhere nobody chose.
  it.each([
    ['a relative escape', '../../.ssh/authorized_keys'],
    ['a windows escape', '..\\..\\Windows\\System32\\evil.exe'],
    ['an absolute windows path', 'C:\\Windows\\System32\\evil.exe'],
    ['a posix absolute path', '/etc/passwd']
  ])('cannot escape the chosen folder with %s', (_label, name) => {
    const safe = safeFileName(name)
    expect(safe).not.toMatch(/[\\/]/)
    expect(safe.startsWith('..')).toBe(false)
  })

  // The one that survives leaving the process. A file written with U+202E is
  // listed by the file manager reversed, so the extension read is not the
  // extension run — and unlike the others this is invisible in the listing.
  it('drops the right-to-left override rather than writing it to disk', () => {
    const safe = safeFileName(`holiday${RTL_OVERRIDE}gnp.exe`)
    expect(safe).toBe('holidaygnp.exe')
    expect([...safe].some((ch) => ch.codePointAt(0) === 0x202e)).toBe(false)
  })

  it.each([
    ['left-to-right mark', '\u200e'],
    ['right-to-left mark', '\u200f'],
    ['left-to-right embedding', '\u202a'],
    ['pop directional formatting', '\u202c'],
    ['first-strong isolate', '\u2068'],
    ['pop directional isolate', '\u2069']
  ])('drops the %s too, not only the override', (_label, ch) => {
    expect(safeFileName(`a${ch}b.txt`)).toBe('ab.txt')
  })

  it('replaces control characters rather than dropping them silently', () => {
    // Replaced rather than removed, so `a\u0000b` cannot become a name that
    // collides with a real `ab`.
    expect(safeFileName('photo\u0000.png')).toBe('photo_.png')
    expect(safeFileName('notes\r\n.txt')).toBe('notes__.txt')
  })

  it.each(['<', '>', ':', '"', '|', '?', '*'])('replaces %s, which Windows refuses', (ch) => {
    // Two letters before the character, not one: `a:` is a drive letter as far
    // as the rule below can tell, and is removed rather than replaced.
    expect(safeFileName(`ab${ch}cd.txt`)).toBe('ab_cd.txt')
  })

  // A single letter followed by a colon is indistinguishable from a drive, so
  // `a:b.txt` loses its first two characters. Lossy and safe, and written down
  // because the alternative is somebody meeting it and calling it a bug.
  it('treats a leading letter and colon as a drive, even when it was a name', () => {
    expect(safeFileName('C:\\Users\\someone\\evil.exe')).toBe('_Users_someone_evil.exe')
    expect(safeFileName('a:b.txt')).toBe('b.txt')
  })

  // These are devices rather than files on Windows, and writing to one does
  // something other than what the person asked for.
  it.each(['CON', 'con.txt', 'PRN.pdf', 'aux', 'NUL.dat', 'COM1', 'lpt9.log'])(
    'defuses the reserved name %s',
    (name) => {
      expect(safeFileName(name).startsWith('_')).toBe(true)
    }
  )

  it('does not mistake an ordinary name for a reserved one', () => {
    expect(safeFileName('console.log')).toBe('console.log')
    expect(safeFileName('contract.pdf')).toBe('contract.pdf')
  })

  it('refuses to produce a hidden file or a trailing dot', () => {
    expect(safeFileName('...hidden')).toBe('hidden')
    expect(safeFileName('trailing.')).toBe('trailing')
    expect(safeFileName('trailing ')).toBe('trailing')
  })

  // Every rule above can consume its whole input, and an empty default path is
  // a dialog with no filename in it.
  it.each([
    ['nothing at all', ''],
    ['only dots', '....'],
    ['only separators', '///'],
    ['only direction marks', '\u202e\u202a'],
    ['undefined', undefined],
    ['a number', 42]
  ])('always returns a usable name, given %s', (_label, name) => {
    const safe = safeFileName(name)
    expect(typeof safe).toBe('string')
    expect(safe.length).toBeGreaterThan(0)
  })

  it('caps the length, because filesystems do', () => {
    expect(safeFileName(`${'a'.repeat(400)}.txt`).length).toBeLessThanOrEqual(255)
  })
})
