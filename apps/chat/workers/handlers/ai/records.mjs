/**
 * What was asked before: the transcript log, searching it, and the summary the
 * dashboard reads.
 */

import { SEARCH_LIMIT, recentActivity, summariseInference } from './support.mjs'

export function recordHandlers(ctx) {
  const { rooms, wallet, network, transcripts, handle } = ctx

  return {
    'ai.history': async () => ({ conversations: await (await transcripts()).transcripts() }),

    /**
     * Searching what a model said, which `room.search` does not cover.
     *
     * Transcripts are a separate log from room history — encrypted under a key
     * only this wallet derives — so the two cannot be searched together without
     * putting a locked wallet's contents into a reply. Kept separate for that
     * reason rather than for want of a merge.
     */
    'ai.search': async (req) => {
      const query = String(req.query ?? '').trim()
      if (query === '') throw new Error('what are you looking for?')

      return { results: await (await transcripts()).search(query, SEARCH_LIMIT) }
    },

    /**
     * Everything the dashboard shows, in one reply.
     *
     * Assembled here rather than in the renderer because it is arithmetic over
     * wei and over the transcript log, and both belong to the data plane. A view
     * that does its own totals is a second implementation of them, and the two
     * drift.
     *
     * Every field is derived from something this machine already holds. Nothing
     * is estimated: where there is no data the field is null, and the interface
     * says so rather than drawing a zero that looks like a measurement.
     */
    'dashboard.read': async (req) => {
      // `exists` as well as `unlocked`, because the address is null while
      // locked and a panel cannot otherwise tell "no wallet" from "shut one".
      const { address, unlocked, exists } = wallet.status()
      const months = Math.min(24, Math.max(1, Number(req.months) || 12))

      // Balances are public, so they survive a locked wallet. Transcripts do
      // not: the key that opens them is derived from the wallet.
      const balances = address ? await handle({ t: 'wallet.balances' }).catch(() => null) : null

      const conversations = unlocked
        ? await (await transcripts()).transcripts().catch(() => [])
        : null

      const states = await rooms.states()

      return {
        network: network(),
        address,
        unlocked,
        exists,
        balances: balances && { native: balances.native, prepaid: balances.prepaid },
        rooms: {
          total: states.length,
          writable: states.filter((room) => room.writable).length,
          messages: states.reduce((n, room) => n + room.messages.length, 0)
        },
        inference: conversations && summariseInference(conversations, months),
        recent: recentActivity(conversations, states)
      }
    },

    'ai.forget': async (req) => {
      await (await transcripts()).deleted(String(req.conversation ?? ''))
      return { ok: true }
    }
  }
}
