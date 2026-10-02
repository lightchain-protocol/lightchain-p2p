/**
 * The container's own state, and the verdict above the whole page.
 *
 * The verdict is the answer and the steps are the evidence — it reads all of
 * them, which is why it is here rather than beside any one step.
 */

import { el } from '../dom.js'
import { lcai, truncate } from '../amounts.js'

import { openSettings } from '../settings.js'

import { containerState, modelsFetch, ui } from './elements.js'
import { GAS_HEADROOM, HEALTH, alertNode, line, plural, setVerdict, when } from './format.js'
import { STEPS } from './rail.js'
import { CHECK_ACTIONS, runAction } from './actions.js'

export function renderContainer(status) {
  el.workerContainer.replaceChildren()

  if (!status.configured) {
    containerState.hidden = true

    // The message from the config layer explains the requirement but not where
    // to satisfy it. It used to name environment variables, which was true
    // before there was anywhere in the app to set them and is now just sending
    // people to a terminal for something two clicks away. The fallback covers
    // a backend that predates `problem`.
    const note = alertNode(
      'info',
      'No worker is configured on this machine',
      status.problem ?? 'The worker settings are incomplete.'
    )

    const open = document.createElement('button')
    open.className = 'button button-sm'
    open.type = 'button'
    open.textContent = 'Open worker settings'
    open.addEventListener('click', () => void openSettings('advanced'))
    note.querySelector('.alert-body').append(open)

    el.workerContainer.append(note)
    return
  }

  const health = HEALTH[status.state.health] ?? { label: status.state.health }
  containerState.hidden = false
  containerState.textContent = health.label
  if (health.tone) containerState.dataset.tone = health.tone
  else delete containerState.dataset.tone

  const facts = document.createElement('dl')
  facts.className = 'facts'
  facts.append(
    ...line('Container', status.containerName),
    ...line('Network', `${status.network} (chain ${status.chainId})`),
    ...line('Models', status.models.join(', ')),
    ...line('Ollama', status.ollamaUrl),
    // The health word is already in the chip above; this is what was observed.
    ...line('State', status.state.detail)
  )
  if (status.state.startedAt) facts.append(...line('Started', when(status.state.startedAt)))
  el.workerContainer.append(facts)

  if (status.state.remedy) {
    const failing = health.tone === 'danger'
    el.workerContainer.append(alertNode(failing ? 'error' : 'info', null, status.state.remedy))
  }
}

export function renderVerdict(host, models, stake, status) {
  // Filled by the branches below, then handed to the step in front of you.
  ui.offers = new Array(STEPS.length).fill(null)

  // Which network the probes were reading when they reached the verdict —
  // null on a backend that predates the field, and the sentence is simply
  // left off.
  const network = stake?.network ?? status?.network ?? null
  const evaluated = network ? ` Evaluated against ${network}.` : ''

  if (!host.ready) {
    const counts = `${host.failed} failed, ${plural(host.warned, 'warning')}, ${host.passed} passed.`
    const first = host.failures.find((result) => result.action)
    setVerdict('fail', `${first?.title ?? 'This machine'} needs attention`, first?.detail ?? counts)
    // Whatever the first failing check offers to do about itself.
    ui.offers[0] = first
      ? {
          label: CHECK_ACTIONS[first.action]?.label ?? 'Fix it',
          run: () => CHECK_ACTIONS[first.action]?.run?.(first)
        }
      : null
    return
  }

  // Before the key, because a worker with no model is a worker that connects
  // and is offered nothing — which reads as a dead network rather than as an
  // unfinished setup.
  const offered = models?.models ?? null
  if (offered !== null) {
    const chosen = offered.filter((model) => model.chosen)
    if (chosen.length === 0) {
      setVerdict(
        'warn',
        'Choose what this machine answers',
        `${plural(offered.length, 'model')} on ${models.network}, each paying per job.`
      )
      // Nothing to press: finishing this step is ticking one of the boxes
      // that is already on screen. A Continue that refuses would be worse.
      ui.offers[1] = null
      return
    }

    const missing = chosen.filter((model) => !model.installed)
    if (missing.length > 0) {
      setVerdict(
        'warn',
        'Download the models you chose',
        `${missing.map((model) => model.name).join(', ')} - several gigabytes, once.`
      )
      ui.offers[1] = { label: 'Download', run: () => modelsFetch.click() }
      return
    }
  }

  if (!stake?.configured) {
    setVerdict('warn', 'The worker is not configured', stake?.problem ?? '')
    ui.offers[0] = { label: 'Open settings', run: () => void openSettings('advanced') }
    return
  }

  if (stake.address === null) {
    setVerdict('warn', 'Give the worker a key', 'It earns to its own key, not to your wallet.')
    ui.offers[2] = {
      label: 'Create a key',
      run: () => document.getElementById('worker-create-password')?.focus()
    }
    return
  }

  if (stake.registered) {
    const running = status.configured && status.healthy
    if (running) {
      setVerdict('ok', 'The worker is running', 'It answers jobs and earns to its own key.')
    } else {
      setVerdict('ok', 'Registered - start the worker', 'The stake is posted.')
      ui.offers[5] = { label: 'Start', run: () => document.getElementById('worker-start').click() }
    }
    return
  }

  if (stake.unreachable || stake.minimum === null || stake.balance === null) {
    setVerdict(
      'warn',
      'The chain could not be read',
      `Check the network setting and that the RPC is reachable.${evaluated}`
    )
    return
  }

  const funded = BigInt(stake.balance) > BigInt(stake.minimum)
  if (!funded) {
    const missing = BigInt(stake.minimum) + GAS_HEADROOM - BigInt(stake.balance)
    setVerdict(
      'warn',
      'Fund the worker key',
      `${lcai(missing.toString())} LCAI short of the ${lcai(stake.minimum)} LCAI it stakes.`
    )
    ui.offers[3] = {
      label: `Send ${lcai(missing.toString())} LCAI`,
      run: () =>
        void runAction({
          command: 'wallet.send',
          args: { to: stake.address, amount: missing.toString() },
          opening: `Sending ${lcai(missing.toString())} LCAI to the worker key. Confirm it in the dialog that appears.`,
          alertSlot: 'worker-stake-alert'
        })
    }
    return
  }

  setVerdict(
    'warn',
    'Ready to register',
    `One transaction posts ${lcai(stake.minimum)} LCAI from ${truncate(stake.address, 6, 4)}.`
  )
  ui.offers[4] = {
    label: 'Register',
    run: () => document.getElementById('worker-register').click()
  }
}
