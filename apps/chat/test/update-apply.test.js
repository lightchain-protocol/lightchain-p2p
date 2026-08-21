import { describe, expect, it } from 'vitest'
import {
  UPDATE_APPLIED_LINE,
  applyStagedUpdate,
  updateFailureLine
} from '../workers/update-apply.mjs'

/**
 * The OTA apply path, without Electron or a real updater.
 *
 * What matters here is ordering and honesty: a failed apply must answer with
 * the failure, must leave the updater retryable, and must never report a
 * success that did not happen. The fake updater below copies
 * pear-runtime-updater's one real quirk — it latches `applied = true` *before*
 * the swap — because resetting that latch on failure is the whole point.
 */

/** A PearRuntime stand-in. `applyUpdate` latches first, then runs `swap`. */
function fakePear({ ready, swap } = {}) {
  const calls = []
  const pear = {
    ready: async () => {
      calls.push('ready')
      await ready?.()
    },
    updater: {
      applied: false,
      applyUpdate: async () => {
        calls.push('apply')
        pear.updater.applied = true
        await swap?.()
      }
    }
  }
  return { pear, calls }
}

function recorder() {
  const lines = []
  return { lines, write: (line) => lines.push(line) }
}

describe('applyStagedUpdate', () => {
  it('reports the success and leaves the latch set', async () => {
    const { pear, calls } = fakePear()
    const { lines, write } = recorder()

    const ok = await applyStagedUpdate(pear, write)

    expect(ok).toBe(true)
    expect(calls).toEqual(['ready', 'apply'])
    expect(lines).toEqual([UPDATE_APPLIED_LINE])
    expect(pear.updater.applied).toBe(true)
  })

  it('answers a thrown apply with the failure and resets the latch', async () => {
    const { pear } = fakePear({
      swap: () => {
        throw new Error('swap target is read-only')
      }
    })
    const { lines, write } = recorder()

    const ok = await applyStagedUpdate(pear, write)

    expect(ok).toBe(false)
    expect(lines).toEqual(['pear:updateFailed swap target is read-only\n'])
    // The latch went on before the swap threw; left alone, every retry would
    // no-op inside applyUpdate and be reported here as a success.
    expect(pear.updater.applied).toBe(false)
  })

  it('treats a failed pear.ready() the same as a failed swap', async () => {
    const { pear, calls } = fakePear({
      ready: () => {
        throw new Error('runtime not booted')
      }
    })
    const { lines, write } = recorder()

    const ok = await applyStagedUpdate(pear, write)

    expect(ok).toBe(false)
    expect(calls).toEqual(['ready'])
    expect(lines).toEqual(['pear:updateFailed runtime not booted\n'])
    expect(pear.updater.applied).toBe(false)
  })

  it('makes a retry after a failure a real second attempt', async () => {
    let attempts = 0
    const { pear } = fakePear({
      swap: () => {
        attempts += 1
        if (attempts === 1) throw new Error('first try fails')
      }
    })
    const { lines, write } = recorder()

    expect(await applyStagedUpdate(pear, write)).toBe(false)
    expect(await applyStagedUpdate(pear, write)).toBe(true)

    expect(attempts).toBe(2)
    expect(lines).toEqual(['pear:updateFailed first try fails\n', UPDATE_APPLIED_LINE])
    expect(pear.updater.applied).toBe(true)
  })
})

describe('updateFailureLine', () => {
  it('keeps the reply on one line, whatever the error held', () => {
    // The pipe is line-delimited; a multi-line message would otherwise be read
    // as several updater-control lines nobody sent.
    expect(updateFailureLine(new Error('one\ntwo\r\nthree'))).toBe(
      'pear:updateFailed one two three\n'
    )
  })

  it('stringifies non-Error throws', () => {
    expect(updateFailureLine('permission denied')).toBe('pear:updateFailed permission denied\n')
  })

  it('never sends an empty message', () => {
    expect(updateFailureLine(new Error(''))).toBe('pear:updateFailed unknown error\n')
    expect(updateFailureLine(null)).toBe('pear:updateFailed null\n')
  })
})
