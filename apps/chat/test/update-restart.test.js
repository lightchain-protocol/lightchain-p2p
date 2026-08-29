import { describe, expect, it, vi } from 'vitest'
import { relaunchPlan, restartAfterUpdate } from '../electron/update-restart.js'

/**
 * The post-update restart, without Electron.
 *
 * Two things are worth protecting here. The ordering — nothing may start until
 * the outgoing worker has let go of the Corestore, or the window that comes
 * back after an update shows an empty account. And the platform split, which is
 * otherwise only checkable by owning each platform: on Windows the MSIX swap
 * restarts the app, so asking for a relaunch there produces two of it.
 */

/** A worker pipe that records being destroyed, and when. */
function fakeWorld({ exits = [], platform = 'darwin', appImage = undefined } = {}) {
  const order = []
  const pipes = [
    { destroy: () => order.push('destroy:a') },
    { destroy: () => order.push('destroy:b') }
  ]

  return {
    order,
    pipes,
    exits,
    plan: relaunchPlan({ platform, appImage, argv: ['electron', '.', '--storage', '/tmp/x'] }),
    relaunch: vi.fn(() => order.push('relaunch')),
    quit: vi.fn(() => order.push('quit')),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}

describe('what relaunching means on each platform', () => {
  it('does not relaunch on Windows — the MSIX swap does it', () => {
    expect(relaunchPlan({ platform: 'win32', argv: [] })).toBeNull()
  })

  it('relaunches plainly on macOS', () => {
    expect(relaunchPlan({ platform: 'darwin', argv: ['e', '.'] })).toEqual({})
  })

  it('relaunches a plain Linux install plainly', () => {
    expect(relaunchPlan({ platform: 'linux', appImage: undefined, argv: ['e', '.'] })).toEqual({})
  })

  it('re-executes an AppImage through its own extract-and-run path', () => {
    // Not the mount it is running from: that is the thing being replaced.
    const plan = relaunchPlan({
      platform: 'linux',
      appImage: '/home/someone/Lightchain.AppImage',
      argv: ['/tmp/.mount_abc/app', '--storage', '/tmp/x']
    })
    expect(plan.execPath).toBe('/home/someone/Lightchain.AppImage')
    expect(plan.args).toEqual(['--appimage-extract-and-run', '--storage', '/tmp/x'])
  })

  it('does not accumulate the flag when relaunching a relaunch', () => {
    const plan = relaunchPlan({
      platform: 'linux',
      appImage: '/x.AppImage',
      argv: ['/tmp/.mount/app', '--appimage-extract-and-run', '--storage', '/tmp/x']
    })
    expect(plan.args.filter((a) => a === '--appimage-extract-and-run')).toHaveLength(1)
  })
})

describe('nothing starts until the worker has gone', () => {
  it('destroys every worker pipe', async () => {
    const w = fakeWorld()
    await restartAfterUpdate({ ...w, timeoutMs: 1000 })
    expect(w.order.filter((s) => s.startsWith('destroy:'))).toEqual(['destroy:a', 'destroy:b'])
  })

  it('waits for the exit before relaunching, not merely for the pipe', async () => {
    let released = () => {}
    const exit = new Promise((resolve) => {
      released = resolve
    })
    const w = fakeWorld({ exits: [exit] })

    const done = restartAfterUpdate({ ...w, timeoutMs: 5000 })

    // The pipe is gone, but the process still holds the Corestore. Starting a
    // replacement here is the bug this ordering exists to prevent.
    await new Promise((r) => setTimeout(r, 20))
    expect(w.relaunch).not.toHaveBeenCalled()
    expect(w.quit).not.toHaveBeenCalled()

    released()
    await done
    expect(w.relaunch).toHaveBeenCalledTimes(1)
    expect(w.order).toEqual(['destroy:a', 'destroy:b', 'relaunch', 'quit'])
  })

  it('restarts anyway when the worker will not exit', async () => {
    // Late is recoverable — the next launch reads the same storage. Never
    // restarting is not.
    const w = fakeWorld({ exits: [new Promise(() => {})] })
    await restartAfterUpdate({ ...w, timeoutMs: 30 })
    expect(w.relaunch).toHaveBeenCalledTimes(1)
    expect(w.quit).toHaveBeenCalledTimes(1)
  })

  it('does not wait at all when there is no worker to wait for', async () => {
    const w = fakeWorld({ exits: [] })
    await restartAfterUpdate({ ...w, timeoutMs: 60_000 })
    expect(w.quit).toHaveBeenCalledTimes(1)
  })
})

describe('the Windows path, from a machine that is not Windows', () => {
  it('quits without relaunching, and still releases the worker first', async () => {
    const w = fakeWorld({ platform: 'win32' })
    await restartAfterUpdate({ ...w, timeoutMs: 1000 })
    expect(w.relaunch).not.toHaveBeenCalled()
    expect(w.quit).toHaveBeenCalledTimes(1)
    expect(w.order).toEqual(['destroy:a', 'destroy:b', 'quit'])
  })

  it('waits for the worker there too, so the MSIX restart finds storage free', async () => {
    let released = () => {}
    const exit = new Promise((resolve) => {
      released = resolve
    })
    const w = fakeWorld({ platform: 'win32', exits: [exit] })

    const done = restartAfterUpdate({ ...w, timeoutMs: 5000 })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.quit).not.toHaveBeenCalled()

    released()
    await done
    expect(w.quit).toHaveBeenCalledTimes(1)
  })
})
