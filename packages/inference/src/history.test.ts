import { describe, expect, it } from 'vitest'
import { History, type Log, type Record } from './index.js'

function memoryLog(): Log & { records: Record[] } {
  const records: Record[] = []
  return {
    records,
    append: async (record) => {
      records.push(record)
    },
    read: async () => records
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 2))

describe('a transcript', () => {
  it('keeps what was said, in order', async () => {
    const history = new History(memoryLog())
    await history.opened('c1', 'llama3-8b')
    await history.said('c1', 'llama3-8b', 'you', 'hello')
    await history.said('c1', 'llama3-8b', 'model', 'hi there', '42')

    const transcripts = await history.transcripts()
    expect(transcripts).toHaveLength(1)

    const transcript = transcripts[0]!
    expect(transcript.id).toBe('c1')
    expect(transcript.model).toBe('llama3-8b')
    expect(transcript.turns.map((turn) => turn.text)).toEqual(['hello', 'hi there'])
    expect(transcript.turns[1]!.jobId).toBe('42')
  })

  it('does not appear until something was actually said', async () => {
    // Opening a conversation and abandoning it before asking anything should
    // not leave an empty entry in the list.
    const history = new History(memoryLog())
    await history.opened('c1', 'llama3-8b')
    expect(await history.transcripts()).toEqual([])
  })

  it('separates conversations', async () => {
    const history = new History(memoryLog())
    await history.said('c1', 'llama3-8b', 'you', 'first')
    await history.said('c2', 'gemma4:e2b', 'you', 'second')

    const transcripts = await history.transcripts()
    expect(transcripts).toHaveLength(2)
    expect(transcripts.map((t) => t.model).sort()).toEqual(['gemma4:e2b', 'llama3-8b'])
  })

  it('orders by the most recent thing said, not by when it started', async () => {
    const history = new History(memoryLog())
    await history.said('old', 'llama3-8b', 'you', 'started first')
    await settle()
    await history.said('new', 'llama3-8b', 'you', 'started second')
    await settle()
    await history.said('old', 'llama3-8b', 'you', 'and spoke again')

    expect((await history.transcripts()).map((t) => t.id)).toEqual(['old', 'new'])
  })
})

describe('deleting', () => {
  it('removes a conversation from the list', async () => {
    const history = new History(memoryLog())
    await history.said('c1', 'llama3-8b', 'you', 'hello')
    await history.said('c2', 'llama3-8b', 'you', 'also hello')

    await history.deleted('c1')
    expect((await history.transcripts()).map((t) => t.id)).toEqual(['c2'])
  })

  it('is a tombstone, because a log cannot forget its middle', async () => {
    const log = memoryLog()
    const history = new History(log)
    await history.said('c1', 'llama3-8b', 'you', 'a secret')
    await history.deleted('c1')

    // Honest about what deletion means here: gone from the list, still in the
    // log. The encryption at rest is what actually protects it.
    expect(log.records.some((r) => r.kind === 'turn' && r.text === 'a secret')).toBe(true)
    expect(await history.transcripts()).toEqual([])
  })

  it('lets an id be reused afterwards', async () => {
    const history = new History(memoryLog())
    await history.said('c1', 'llama3-8b', 'you', 'first life')
    await history.deleted('c1')
    await history.said('c1', 'llama3-8b', 'you', 'second life')

    const transcripts = await history.transcripts()
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0]!.turns.map((t) => t.text)).toEqual(['second life'])
  })
})

describe('reading a log back', () => {
  it('rebuilds from the records alone', async () => {
    // Restarting means replaying the log, so a History built over the same
    // records must produce the same transcripts.
    const log = memoryLog()
    const first = new History(log)
    await first.said('c1', 'llama3-8b', 'you', 'hello')
    await first.said('c1', 'llama3-8b', 'model', 'hi')

    const second = new History({ append: log.append, read: log.read })
    expect(await second.transcripts()).toEqual(await first.transcripts())
  })
})
