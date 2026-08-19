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

describe('searching what was said', () => {
  async function stocked() {
    const history = new History(memoryLog())
    await history.said('c1', 'llama3-8b', 'you', 'how do I open a Hypercore?')
    await settle()
    await history.said('c1', 'llama3-8b', 'model', 'Call corestore.get with a name.')
    await settle()
    await history.said('c2', 'mistral-7b', 'you', 'what is a hypercore, briefly?')
    await settle()
    await history.said('c2', 'mistral-7b', 'model', 'An append-only log.')
    return history
  }

  it('finds a turn in any conversation', async () => {
    const matches = await (await stocked()).search('hypercore')
    expect(matches.map((match) => match.conversation)).toEqual(['c2', 'c1'])
  })

  it('ignores case, so nobody has to remember how they typed it', async () => {
    const history = await stocked()
    expect(await history.search('HYPERCORE')).toEqual(await history.search('hypercore'))
  })

  it('matches inside a word, which is what a substring search is for', async () => {
    const matches = await (await stocked()).search('corestore.get')
    expect(matches).toHaveLength(1)
    expect(matches[0]!.role).toBe('model')
  })

  it('carries the model and job id, so a result stands on its own', async () => {
    const history = new History(memoryLog())
    await history.said('c1', 'llama3-8b', 'model', 'the answer', '77')

    const match = (await history.search('answer'))[0]!
    expect(match.model).toBe('llama3-8b')
    expect(match.jobId).toBe('77')
    expect(match.conversation).toBe('c1')
  })

  it('is newest first', async () => {
    const matches = await (await stocked()).search('a')
    const times = matches.map((match) => match.at)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('finds nothing for a query of only spaces, rather than everything', async () => {
    expect(await (await stocked()).search('   ')).toEqual([])
  })

  it('finds nothing rather than throwing when there is no match', async () => {
    expect(await (await stocked()).search('autobase')).toEqual([])
  })

  // A tombstone that hid a conversation from the list but not from search would
  // be worse than not offering deletion at all.
  it('cannot find a conversation that was deleted', async () => {
    const history = await stocked()
    await history.deleted('c1')

    const matches = await history.search('hypercore')
    expect(matches.map((match) => match.conversation)).toEqual(['c2'])
  })

  it('honours the limit', async () => {
    const history = new History(memoryLog())
    for (let i = 0; i < 10; i++) {
      await history.said('c1', 'llama3-8b', 'you', `question ${i}`)
      await settle()
    }

    expect(await history.search('question', 3)).toHaveLength(3)
  })

  // The limit takes the newest, not whichever ten the loop reached first.
  it('keeps the newest when the limit bites', async () => {
    const history = new History(memoryLog())
    for (let i = 0; i < 5; i++) {
      await history.said('c1', 'llama3-8b', 'you', `question ${i}`)
      await settle()
    }

    expect((await history.search('question', 2)).map((m) => m.text)).toEqual([
      'question 4',
      'question 3'
    ])
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
