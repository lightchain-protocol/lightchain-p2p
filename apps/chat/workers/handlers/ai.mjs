/**
 * Everything the app does with a model, gathered from four groups.
 *
 * The map was one object of twenty-five handlers with four hundred lines of
 * helpers above it. What each group owns is in its own file now; this composes
 * them over one context and one shared kit, so they cannot drift onto separate
 * spending ledgers.
 */

import { createKit } from './ai/kit.mjs'
import { fundingHandlers } from './ai/funding.mjs'
import { remedyHandlers } from './ai/remedies.mjs'
import { conversationHandlers } from './ai/conversation.mjs'
import { recordHandlers } from './ai/records.mjs'

// The two other modules reach for by name. `relayUrlFor` is read by the network
// tests; `modelFee` by the worker handlers, which price a model without going
// near a conversation. Re-exported here so the entry point stays the address
// for this domain rather than callers reaching into its parts.
export { modelFee, relayUrlFor } from './ai/support.mjs'

export function aiHandlers(ctx) {
  const kit = createKit(ctx)

  return {
    ...fundingHandlers(ctx, kit),
    ...remedyHandlers(ctx, kit),
    ...conversationHandlers(ctx, kit),
    ...recordHandlers(ctx)
  }
}
