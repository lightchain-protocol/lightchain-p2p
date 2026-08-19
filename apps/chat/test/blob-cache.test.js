import { describe, expect, it } from 'vitest'
import { blobCache } from '../renderer/lib/blob-cache.js'

/** An entry of `n` bytes, the shape the attachment view stores. */
const entry = (n, sniffed = 'image/png') => ({ bytes: new Uint8Array(n), sniffed })

describe('the attachment byte cache', () => {
  it('gives back what it was given', () => {
    const cache = blobCache(100)
    cache.remember('a', entry(10, 'image/gif'))

    expect(cache.recall('a')?.sniffed).toBe('image/gif')
    expect(cache.recall('a')?.bytes.byteLength).toBe(10)
  })

  it('is null for something it never held', () => {
    expect(blobCache(100).recall('nothing')).toBeNull()
  })

  it('tracks what it is holding', () => {
    const cache = blobCache(100)
    cache.remember('a', entry(10))
    cache.remember('b', entry(20))

    expect(cache.bytes).toBe(30)
    expect(cache.size).toBe(2)
  })

  // The whole point of a bound. A conversation has no length limit and an
  // attachment runs to 25 MB.
  it('evicts to stay inside the limit', () => {
    const cache = blobCache(100)
    cache.remember('a', entry(60))
    cache.remember('b', entry(60))

    expect(cache.bytes).toBeLessThanOrEqual(100)
    expect(cache.recall('a')).toBeNull()
    expect(cache.recall('b')).not.toBeNull()
  })

  it('evicts the least recently used, not the oldest', () => {
    const cache = blobCache(100)
    cache.remember('a', entry(40))
    cache.remember('b', entry(40))

    // Touching `a` makes `b` the oldest use even though it was stored later.
    cache.recall('a')
    cache.remember('c', entry(40))

    expect(cache.recall('a')).not.toBeNull()
    expect(cache.recall('b')).toBeNull()
    expect(cache.recall('c')).not.toBeNull()
  })

  // Somebody looking at a 30 MB image wants that image. Dropping it to satisfy
  // a budget would mean fetching it again immediately.
  it('keeps what was just stored even when it alone exceeds the limit', () => {
    const cache = blobCache(100)
    cache.remember('small', entry(10))
    cache.remember('huge', entry(500))

    expect(cache.recall('huge')).not.toBeNull()
    expect(cache.recall('small')).toBeNull()
  })

  it('does not double-count a replacement', () => {
    const cache = blobCache(1000)
    cache.remember('a', entry(100))
    cache.remember('a', entry(30))

    expect(cache.bytes).toBe(30)
    expect(cache.size).toBe(1)
    expect(cache.recall('a')?.bytes.byteLength).toBe(30)
  })

  // A replacement kept its original position under `Map.set`, so the newest
  // entry could be the next one evicted.
  it('treats a replacement as the most recently used', () => {
    const cache = blobCache(100)
    cache.remember('a', entry(40))
    cache.remember('b', entry(40))
    cache.remember('a', entry(40))

    // `b` is now the oldest use, so it goes rather than the freshly written `a`.
    cache.remember('c', entry(40))

    expect(cache.recall('a')).not.toBeNull()
    expect(cache.recall('b')).toBeNull()
  })

  it('never lets the total drift from what it holds', () => {
    const cache = blobCache(250)
    for (let i = 0; i < 40; i++) cache.remember(`k${i % 7}`, entry(30 + (i % 5)))

    expect(cache.bytes).toBeLessThanOrEqual(250)
    expect(cache.bytes).toBeGreaterThan(0)
  })

  it('holds nothing at all when the limit is zero, bar the newest', () => {
    const cache = blobCache(0)
    cache.remember('a', entry(10))
    cache.remember('b', entry(10))

    expect(cache.size).toBe(1)
    expect(cache.recall('b')).not.toBeNull()
  })
})
