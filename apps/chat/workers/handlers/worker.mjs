/**
 * Everything about running a worker on this machine.
 *
 * Three pieces of machinery — the keystore, registration, and running things —
 * and four groups of handlers over them. It was one factory with five hundred
 * lines of setup above its handler map.
 */

import { createKeystore } from './worker/keystore.mjs'
import { createRegistration } from './worker/registration.mjs'
import { createRun } from './worker/run.mjs'
import { workerStatusHandlers } from './worker/status.mjs'
import { workerLifecycleHandlers } from './worker/lifecycle.mjs'
import { workerModelHandlers } from './worker/models.mjs'
import { workerKeyHandlers } from './worker/keys.mjs'

// Read by the worker services and by the tests, which check the password rules
// and the hosting rule directly. Re-exported so this file stays the address for
// the domain rather than callers reaching into its parts.
export {
  WORKER_PASSWORD_DOC,
  checkKeystorePassword,
  hostingAvailable,
  migrateWorkerPassword,
  readWorkerPassword
} from './worker/support.mjs'

export function workerHandlers(ctx) {
  const keystore = createKeystore(ctx)
  const registration = createRegistration(ctx)
  const kit = { ...keystore, ...registration }
  const run = createRun(ctx, kit)
  Object.assign(kit, run)

  return {
    ...workerStatusHandlers(ctx),
    ...workerLifecycleHandlers(ctx, kit),
    ...workerModelHandlers(ctx, kit),
    ...workerKeyHandlers(ctx, kit)
  }
}
