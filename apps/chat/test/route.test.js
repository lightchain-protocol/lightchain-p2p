import { describe, expect, it } from 'vitest'
import {
  VALIDATOR_STEP_COUNT,
  WORKER_STEP_COUNT,
  firstOutstanding,
  isReachable,
  validatorRoute,
  workerRoute
} from '../renderer/lib/route.js'

/**
 * The rule that decides what a setup route looks like.
 *
 * This lived inside the module that draws the wizard, so the only way to ask it
 * a question was to start Electron, reach the page, and look at the colour of a
 * circle. Every mistake in it consequently shipped: a step that met people in
 * the failure colour the moment they arrived at it, and a rail that let them
 * press through to a step whose prerequisites did not exist.
 *
 * The cases below are those mistakes, plus the ones next door to them.
 */

/** A machine with nothing wrong, so each test only states what it is about. */
const HEALTHY = { host: { failed: 0 }, models: null, stake: null, status: null }

describe('the worker route', () => {
  it('is six steps, and starts with the machine check', () => {
    expect(workerRoute(HEALTHY)).toHaveLength(WORKER_STEP_COUNT)
    expect(workerRoute(HEALTHY)[0]).toBe('done')
    expect(workerRoute({ ...HEALTHY, host: { failed: 2 } })[0]).toBe('blocked')
  })

  it('calls an untouched model list outstanding, not blocked', () => {
    // The bug this pins. `blocked` is the failure colour, and it was claimed
    // the moment nothing was ticked — so the step whose whole job is to be
    // filled in greeted people in red, between two green ones.
    const route = workerRoute({
      ...HEALTHY,
      models: { models: [{ name: 'llama3-8b', chosen: false, installed: true }] }
    })

    expect(route[1]).toBe('todo')
  })

  it('calls a chosen model that is not on the machine blocked', () => {
    // The other half: a decision has been made and the step still cannot pass.
    // That is what `blocked` is for, and dropping it would have been the wrong
    // fix for the case above.
    const route = workerRoute({
      ...HEALTHY,
      models: { models: [{ name: 'llama3-8b', chosen: true, installed: false }] }
    })

    expect(route[1]).toBe('blocked')
  })

  it('calls a chosen model that is present done', () => {
    const route = workerRoute({
      ...HEALTHY,
      models: { models: [{ name: 'llama3-8b', chosen: true, installed: true }] }
    })

    expect(route[1]).toBe('done')
  })

  it('says nothing about models the network has not answered for', () => {
    // A whitelist nobody could read is not an empty whitelist.
    expect(workerRoute({ ...HEALTHY, models: { models: null } })[1]).toBe('todo')
  })

  it('blocks funding when the key cannot cover the stake', () => {
    const route = workerRoute({
      ...HEALTHY,
      models: { models: [{ chosen: true, installed: true }] },
      stake: {
        configured: true,
        address: '0xabc',
        minimum: '50000',
        balance: '1',
        registered: false
      }
    })

    expect(route[2]).toBe('done')
    expect(route[3]).toBe('blocked')
  })

  it('lets only one step claim a problem at a time', () => {
    // Four red marks at once says "everything is broken" when the truth is
    // "fix this, then look again". Anything blocked after the first gap is
    // usually only waiting on that gap.
    const route = workerRoute({
      host: { failed: 1 },
      models: { models: [{ chosen: true, installed: false }] },
      stake: {
        configured: true,
        address: '0xabc',
        minimum: '50000',
        balance: '0',
        registered: false
      },
      status: null
    })

    expect(route.filter((state) => state === 'blocked')).toEqual(['blocked'])
    expect(route[0]).toBe('blocked')
  })

  it('marks registering done once the chain says so', () => {
    const route = workerRoute({
      ...HEALTHY,
      models: { models: [{ chosen: true, installed: true }] },
      stake: { configured: true, address: '0xabc', registered: true },
      status: { configured: true, healthy: true }
    })

    expect(route).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
  })
})

describe('what a route lets you reach', () => {
  it('lets you open the first outstanding step and everything before it', () => {
    const route = ['done', 'todo', 'todo', 'todo']

    expect(isReachable(route, 0)).toBe(true)
    expect(isReachable(route, 1)).toBe(true)
  })

  it('refuses a step whose prerequisites are not there yet', () => {
    // From Models with nothing ticked you could press straight through to
    // Register, where nothing would have worked — the wizard asking for things
    // in an order it had itself said was wrong.
    const route = ['done', 'todo', 'todo', 'todo']

    expect(isReachable(route, 2)).toBe(false)
    expect(isReachable(route, 3)).toBe(false)
  })

  it('keeps a finished step reachable even when an earlier one is not', () => {
    // The worker's key exists whether or not a model has been chosen. Hiding a
    // finished step to enforce an order it does not depend on is its own lie.
    const route = ['done', 'todo', 'done', 'todo']

    expect(isReachable(route, 2)).toBe(true)
    expect(isReachable(route, 3)).toBe(false)
  })

  it('lets you back onto every step once they are all done', () => {
    const route = ['done', 'done', 'done', 'done']

    expect(route.every((unused, index) => isReachable(route, index))).toBe(true)
    expect(firstOutstanding(route)).toBe(route.length - 1)
  })
})

describe('the validator route', () => {
  it('is four steps, and starts on keys', () => {
    const route = validatorRoute({ keys: { keys: [] } })

    expect(route).toHaveLength(VALIDATOR_STEP_COUNT)
    expect(route[0]).toBe('todo')
  })

  it('counts a deposit built this session, before the chain has seen it', () => {
    // Otherwise the step somebody just completed reverts to outstanding while
    // the beacon chain catches up.
    const route = validatorRoute({ keys: { keys: [] }, pending: { deposits: 1 } })

    expect(route[0]).toBe('done')
  })

  it('finishes running and watching once a validator is active', () => {
    const route = validatorRoute({ keys: { keys: [{ status: 'active_ongoing' }] } })

    expect(route).toEqual(['done', 'done', 'done', 'done'])
  })

  it('does not call a pending validator active', () => {
    const route = validatorRoute({ keys: { keys: [{ status: 'pending_queued' }] } })

    expect(route).toEqual(['done', 'done', 'todo', 'todo'])
  })
})
