import { afterEach, describe, expect, it } from 'vitest'
import { output, outputAsync, widenPath } from './run.js'

/**
 * A desktop launch does not get a terminal's PATH.
 *
 * The check that reported "the docker command was not found" on a Mac with
 * Docker running was correct about what it saw: started from the Finder the
 * app's PATH is four system directories, and Docker Desktop's link is in none
 * of them.
 */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('widenPath', () => {
  it('adds where Docker Desktop, Homebrew and Foundry install on a Mac', () => {
    const path = widenPath(FINDER_PATH, '/Users/someone', 'darwin')!.split(':')

    expect(path).toContain('/usr/local/bin')
    expect(path).toContain('/opt/homebrew/bin')
    expect(path).toContain('/Users/someone/.docker/bin')
    expect(path).toContain('/Applications/Docker.app/Contents/Resources/bin')
    expect(path).toContain('/Users/someone/.foundry/bin')
  })

  it("keeps the caller's own order first, and repeats nothing", () => {
    const path = widenPath('/opt/custom/bin:/usr/local/bin:/usr/bin', '/home/x', 'linux')!.split(
      ':'
    )

    expect(path.slice(0, 3)).toEqual(['/opt/custom/bin', '/usr/local/bin', '/usr/bin'])
    expect(new Set(path).size).toBe(path.length)
    expect(path).toContain('/snap/bin')
  })

  it('builds a path where there was none at all', () => {
    expect(widenPath(undefined, '', 'darwin')!.split(':')).toContain('/usr/local/bin')
  })

  it('leaves Windows alone', () => {
    expect(widenPath('C:\\Windows;C:\\Docker', 'C:\\Users\\x', 'win32')).toBe(
      'C:\\Windows;C:\\Docker'
    )
    expect(widenPath(undefined, '', 'win32')).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('a command run from a desktop launch', () => {
  const original = process.env.PATH

  afterEach(() => {
    process.env.PATH = original
  })

  it('is given the widened PATH, blocking or not', async () => {
    process.env.PATH = FINDER_PATH

    expect(output('/bin/sh', ['-c', 'echo "$PATH"'])).toContain('/usr/local/bin')
    expect(await outputAsync('/bin/sh', ['-c', 'echo "$PATH"'])).toContain('/usr/local/bin')
  })

  it('still carries what the caller added to the environment', () => {
    process.env.PATH = FINDER_PATH
    expect(output('/bin/sh', ['-c', 'echo "$LC_PROBE"'], { env: { LC_PROBE: 'kept' } })).toBe(
      'kept'
    )
  })
})
