/**
 * Attachment bytes already fetched, keyed by the digest they were signed with.
 *
 * A room re-renders in full whenever anything in it changes, so without this
 * one arriving message would refetch every image on screen. The digest is the
 * only sound key: the worker has already refused to hand over bytes that do not
 * hash to it, so two attachments sharing one are the same bytes whatever they
 * happen to be called.
 *
 * Bounded, because an attachment runs to 25 MB and a conversation does not run
 * to anything in particular. Eviction is by least recent use, which is the
 * wrong guess for somebody scrolling upwards through a year of photographs and
 * the right one for the ordinary case of reading a room as it arrives.
 *
 * Its own module so the eviction can be tested. It is pure — a Map, a running
 * total and a limit — and a cache that quietly stops evicting is the kind of
 * fault that shows up as an application getting slower over an afternoon rather
 * than as anything failing.
 */

const DEFAULT_LIMIT = 48 * 1024 * 1024

export function blobCache(limit = DEFAULT_LIMIT) {
  const held = new Map()
  let total = 0

  return {
    /** Bytes for `hash`, or null. Reading counts as use. */
    recall(hash) {
      const entry = held.get(hash)
      if (!entry) return null
      // Reinserted, so insertion order — which is what a Map iterates — becomes
      // an order of use rather than an order of arrival.
      held.delete(hash)
      held.set(hash, entry)
      return entry
    },

    /**
     * Keeps `entry` under `hash`, evicting the least recently used until the
     * total is inside the limit.
     *
     * What was just stored is never the thing evicted, even when it alone
     * exceeds the limit. Somebody looking at a 30 MB image wants that image;
     * dropping it to satisfy a budget would mean fetching it again immediately.
     */
    remember(hash, entry) {
      const existing = held.get(hash)
      if (existing) total -= existing.bytes.byteLength

      // Deleted first so a replacement lands at the end of the iteration order
      // rather than keeping the position it was first inserted at, which would
      // make it the next thing evicted despite being the newest.
      held.delete(hash)
      held.set(hash, entry)
      total += entry.bytes.byteLength

      for (const [key, evicted] of held) {
        if (total <= limit) break
        if (key === hash) continue
        held.delete(key)
        total -= evicted.bytes.byteLength
      }
    },

    /** For tests and for anything that wants to say how much is held. */
    get bytes() {
      return total
    },

    get size() {
      return held.size
    }
  }
}
