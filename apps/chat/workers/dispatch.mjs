/**
 * Which request goes to which handler.
 *
 * The whole routing table in one place, so adding a request means touching this
 * file and the handler module — not the boot sequence.
 */

import { roomHandlers } from './handlers/rooms.mjs'
import { walletHandlers } from './handlers/wallet.mjs'
import { validatorHandlers } from './handlers/validator.mjs'
import { assetHandlers } from './handlers/assets.mjs'
import { historyHandlers } from './handlers/history.mjs'
import { bridgeHandlers } from './handlers/bridge.mjs'
import { swapHandlers } from './handlers/swap.mjs'
import { aiHandlers } from './handlers/ai.mjs'
import { workerHandlers } from './handlers/worker.mjs'
import { settingsHandlers } from './handlers/settings.mjs'
import { localHandlers } from './handlers/local.mjs'

export function createDispatch({ ctx, guard }) {
  /**
   * Every request the renderer can make, by name.
   *
   * The null prototype is load-bearing. Without it `{ t: 'toString' }` would find
   * `Object.prototype.toString` and be dispatched as though it were a handler,
   * which turns a typo — or anything the renderer is talked into sending — into a
   * confusing failure well inside the reply path.
   */
  const handlers = {
    __proto__: null,
    /**
     * The window's answer to the guard's `wallet.confirm` push.
     *
     * Registered here rather than in a handler module because the guard is the
     * only state it touches, and it is handed to this table directly rather than
     * through the context. An id nobody asked about settles nothing — see
     * guard.settle.
     */
    'wallet.confirmed': ({ id, approved }) => guard.settle(id, approved === true),
    ...roomHandlers(ctx),
    ...walletHandlers(ctx),
    ...assetHandlers(ctx),
    ...historyHandlers(ctx),
    ...bridgeHandlers(ctx),
    ...swapHandlers(ctx),
    ...aiHandlers(ctx),
    ...workerHandlers(ctx),
    ...validatorHandlers(ctx),
    ...settingsHandlers(ctx),
    ...localHandlers(ctx),
    // Loaded on demand, since a working session never calls it: packs the logs,
    // a generated report and the doctor's probe summary into a ZIP the renderer
    // saves through the existing attachment flow. Nothing secret is included —
    // see workers/diagnostics.mjs for the enumerated list.
    'diagnostics.export': () => import('./diagnostics.mjs').then((m) => m.exportDiagnostics(ctx))
  }

  async function handle(req) {
    const handler = handlers[req.t]
    if (!handler) throw new Error(`unknown request: ${String(req.t)}`)
    return handler(req)
  }

  return handle
}
