/**
 * Running things: the Docker actions, the host commands behind them, and the
 * one-at-a-time lock that stops a start racing a stop.
 */

import { aliasModel, modelCandidates, plainText, pullModel, runAsync } from '@lcai-p2p/host'

import {
  NETWORKS,
  generateEncryptionKey,
  pullImage,
  register as registerWorker,
  resolveContractAddresses,
  runWorker,
  stopWorker
} from '@lcai-p2p/worker'

import { Api } from '@lcai-p2p/inference'

import { hostingAvailable, hostingUnavailable, keystoreFor } from './support.mjs'

export function createRun(ctx, kit) {
  const { rpc, send, workerConfig } = ctx
  const { confirmStake, recordStake } = kit

  /** One Docker action at a time, so a start cannot race a stop. */
  let busyWith = null

  /**
   * The things an operator does repeatedly: fetch the image, start it, stop
   * it.
   *
   * Key import and creation are not here because they are not Docker actions —
   * they are file writes, handled below by `worker.importKey` and
   * `worker.createKey`.
   */
  /**
   * One host action at a time, whichever it is.
   *
   * A model pull and a `docker pull` are both minutes long and both write to
   * the same log pane, so the guard that kept two Docker verbs apart has to
   * cover the Ollama ones too — otherwise the pane interleaves two commands
   * and the panel disables buttons for one of them.
   */
  async function withBusy(doing, fn) {
    if (busyWith) throw new Error(`already ${busyWith}`)
    busyWith = doing
    send({ t: 'worker.busy', doing })

    try {
      return await fn()
    } finally {
      busyWith = null
      send({ t: 'worker.busy', doing: null })
    }
  }

  /**
   * Runs a docker command, streaming its output as it arrives.
   *
   * No timeout: a pull is minutes on a cold host, and killing it halfway
   * leaves a partial image that fails in a less obvious way.
   */
  async function dockerRun(command) {
    let streamed = false
    const res = await runAsync('docker', command.argv, {
      timeout: 0,
      onOutput: (chunk) => {
        streamed = true
        send({ t: 'worker.output', text: chunk })
      }
    })

    if (!res.ok) {
      // Docker's own words already reached the log as they were written, so
      // repeating them here prints the same failure twice. When nothing was
      // streamed they are all there is.
      throw new Error(
        streamed
          ? `docker exited ${res.status}`
          : res.stderr.trim() || res.stdout.trim() || `docker exited ${res.status}`
      )
    }

    return res
  }

  /**
   * The same for a plain host command, and the command is echoed first.
   *
   * Somebody watching a four-gigabyte model download deserves to know which of
   * the two commands they are watching. The output is put through `plainText`
   * because Ollama draws its progress with carriage returns and ANSI escapes,
   * and the pane is an element's textContent rather than a terminal.
   */
  async function hostRun(command) {
    send({ t: 'worker.output', text: `\n$ ${command.display}\n` })

    let streamed = false
    const res = await runAsync(command.file, [...command.args], {
      timeout: 0,
      onOutput: (chunk) => {
        streamed = true
        send({ t: 'worker.output', text: plainText(chunk) })
      }
    })

    if (!res.ok) {
      throw new Error(
        streamed
          ? `${command.file} exited ${res.status}`
          : plainText(res.stderr.trim() || res.stdout.trim()) ||
              `${command.file} exited ${res.status}`
      )
    }

    return res
  }

  /**
   * The models this network whitelists, asked of the network.
   *
   * Unauthenticated on purpose: `/api/models` needs no token, and the Earn page
   * has to be able to show what a machine could serve before there is a wallet
   * unlocked or a key imported. Signing in to read a public list would put a
   * password prompt in front of the first question anybody asks.
   */
  async function offeredModels(config) {
    const api = new Api({
      url: NETWORKS[config.network].consumerApiUrl,
      chainId: BigInt(config.chainId)
    })
    return api.models()
  }

  /**
   * Fetches one model under whichever name the registry actually publishes it.
   *
   * The network's name and the registry's reference are the same thing spelled
   * two ways, and which way is a convention rather than a rule — so the
   * candidates are tried in order and the first that pulls wins. A failure is
   * only a failure once every candidate has been tried, and it says which were.
   *
   * The copy afterwards is the half that matters. The worker resolves jobs by
   * `keccak256` of the network's exact name, so a model left under its registry
   * reference is one the worker cannot find: it starts, takes work, and
   * resolves none of it, with nothing in any log that says why.
   */
  async function fetchOne(name) {
    const candidates = modelCandidates(name)
    let last = null

    for (const [index, reference] of candidates.entries()) {
      try {
        await hostRun(pullModel(reference))
      } catch (err) {
        last = err
        const more = index < candidates.length - 1
        send({
          t: 'worker.output',
          text: `\nNothing is published as ${reference}${more ? ' — trying the next name' : ''}.\n`
        })
        continue
      }

      const alias = aliasModel(reference, name)
      if (alias !== null) await hostRun(alias)
      return reference
    }

    throw new Error(
      `${name} could not be fetched: nothing is published under ${candidates.join(' or ')}. ${
        last?.message ?? ''
      }`.trim()
    )
  }

  async function docker(req) {
    const { config, problem } = workerConfig()
    if (!config) throw new Error(problem ?? 'the worker is not configured')

    // A network with no image or gateway has nothing to pull, register or
    // start — refused here, before a stake is read or a container command
    // could be built around an absent image. Stop still goes through: it
    // needs only the container name, and a container started while another
    // network was selected must remain stoppable after the switch.
    if (req.t !== 'worker.stop' && !hostingAvailable(config)) {
      throw new Error(hostingUnavailable(config.network))
    }

    const doing = {
      'worker.pull': 'pulling',
      'worker.register': 'registering',
      'worker.start': 'starting',
      'worker.stop': 'stopping'
    }[req.t]

    return withBusy(doing, async () => {
      // Registering is not a key ceremony. It opens a keystore already
      // on disk and sends a transaction, which is the same shape as
      // starting — unlike import-key, which reads a private key from
      // stdin so it never reaches argv, the environment or a log.
      //
      // Register and start both need the contract addresses. Mainnet's
      // profile pins them; testnet's deliberately does not, so the live
      // pair is read from the WorkerRegistry predeploy — without this a
      // testnet worker could never leave the panel.
      const resolved =
        req.t === 'worker.register' || req.t === 'worker.start'
          ? await resolveContractAddresses(config, rpc())
          : config

      // The stake is confirmed before the container exists: `docker run` is
      // the point past which the Go binary can sign, and a refusal must not
      // reach it. Null when the key is already registered and nothing stakes.
      const stake = req.t === 'worker.register' ? await confirmStake(resolved) : null

      // Step 4 of the published guide, folded into this one rather than left
      // standing as a phase of its own. Registering advertises an ECDH public
      // key on chain, the container generates that key pair, and the guide has
      // an operator run `keygen` by hand between importing the key and
      // registering. Nothing in this application ever did — only the terminal
      // supervisor exposed it — so a worker set up entirely through the panel
      // registered without one.
      //
      // Gated on `stake`, which is null exactly when the key is already
      // registered. That is not a nicety: the advertised public key is what
      // consumers encrypt to, and generating a fresh pair under a live
      // registration would leave the worker unable to read its own jobs. The
      // one moment this is safe is the one moment it is needed.
      if (stake !== null) {
        send({ t: 'worker.output', text: '\nGenerating the encryption key…\n' })
        await dockerRun(generateEncryptionKey(resolved))
      }

      const command =
        req.t === 'worker.pull'
          ? pullImage(resolved)
          : req.t === 'worker.stop'
            ? stopWorker(resolved)
            : req.t === 'worker.register'
              ? registerWorker(resolved, keystoreFor(resolved))
              : runWorker(resolved, keystoreFor(resolved))

      const res = await dockerRun(command)

      // The stake left the worker key inside the container, outside every path
      // that would normally write it down. Record it now that the transaction
      // is mined; a recording failure is logged, never thrown — see recordStake.
      if (req.t === 'worker.register' && stake !== null) {
        await recordStake(resolved, stake, res.stdout)
      }

      return { ok: true }
    })
  }

  return { withBusy, dockerRun, hostRun, offeredModels, fetchOne, docker }
}
