/**
 * Bringing the worker up and down, and the two things it needs running first.
 */

import { hostPlatform, probeDocker, probeOllama, startDocker, startOllama } from '@lcai-p2p/host'

import { stakeProbe } from './support.mjs'

export function workerLifecycleHandlers(ctx, kit) {
  const { rpc, workerConfig } = ctx
  const { withBusy, hostRun, docker } = kit

  return {
    'worker.pull': docker,

    'worker.register': docker,

    'worker.start': docker,

    'worker.stop': docker,

    /**
     * Starting Docker, on the one platform where that is a thing we can do.
     *
     * Waits for the daemon rather than for the application, which is the whole
     * difference the check draws: `open` returns as soon as Docker Desktop is
     * launching, and its daemon takes a good deal longer to accept a
     * connection. Answering earlier would report a host as ready that would
     * refuse the very next command.
     */
    'worker.startDocker': async () => {
      const command = startDocker(hostPlatform())
      if (command === null) {
        throw new Error(
          'there is no start command we can run on this platform - start Docker the way you normally would, and this check will pass once its daemon answers'
        )
      }

      return withBusy('starting Docker', async () => {
        await hostRun(command)

        for (let attempt = 0; attempt < 45; attempt++) {
          const probe = await probeDocker()
          if (probe?.daemonRunning) return { ok: true, running: true }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }

        // Not an error. Docker Desktop is slow to start on a cold machine, and
        // a daemon still coming up is not a daemon that failed.
        return { ok: true, running: false }
      })
    },

    /**
     * Starting the model runtime, where the platform gives us a handle on it.
     *
     * Deliberately not `ollama serve`: that command never exits, and a server
     * owned by this process would die with the window — a worker that stops
     * answering when somebody closes the app looks like a worker that is
     * broken. Each platform's own launcher is used instead.
     *
     * Waits for the port before answering. `open` returns when the app has
     * been launched, not when it is listening, and a panel that refreshed in
     * between reported the runtime as still down — which reads as the button
     * having done nothing.
     */
    'worker.startOllama': async () => {
      const command = startOllama(hostPlatform())
      if (command === null) {
        throw new Error(
          'there is no start command we can run on this platform - open Ollama the way you normally would and it will answer on port 11434'
        )
      }

      return withBusy('starting Ollama', async () => {
        await hostRun(command)

        for (let attempt = 0; attempt < 20; attempt++) {
          const probe = await probeOllama()
          if (probe.reachable) return { ok: true, reachable: true }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }

        // Not an error: the launcher succeeded, and a runtime still starting
        // twenty seconds later is a slow machine rather than a failure.
        return { ok: true, reachable: false }
      })
    },

    /**
     * The stake requirement, as numbers rather than as a prose check.
     *
     * `worker.doctor` folds the probe into a checklist row; the panel's stake
     * step needs the raw figures — the minimum read from the chain, the
     * balance, the address to fund — to say exactly what is missing. Amounts
     * cross as decimal strings in wei because JSON has no bigint.
     */
    'worker.stake': async () => {
      // Same placeholder password as doctor: resolving the config is how the
      // keys directory is learned, and no keystore is opened here.
      const { config, problem } = workerConfig({ keystorePassword: 'unset' })
      if (!config) return { configured: false, problem, network: null }

      const probe = await stakeProbe(rpc(), config)
      return {
        configured: true,
        // Which network was probed — a stake answer without its chain is how
        // "registered on testnet" gets read as "registered".
        network: config.network,
        address: probe.address ?? null,
        // Null on success; the probe's own words on failure, so an ambiguous
        // keystore directory no longer renders identically to a wiped install.
        problem: probe.problem ?? null,
        registered: probe.registered === true,
        unreachable: probe.unreachable === true,
        minimum: probe.minimum === undefined ? null : probe.minimum.toString(),
        balance: probe.balance === undefined ? null : probe.balance.toString()
      }
    }
  }
}
