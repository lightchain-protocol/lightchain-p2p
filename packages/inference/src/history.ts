/**
 * What was asked, and what came back.
 *
 * ## Why this is encrypted
 *
 * Room messages are already encrypted at rest, so plaintext transcripts beside
 * them would be the weakest thing in the directory — and prompts are usually
 * more revealing than chat, because people tell a model things they would not
 * say to a person.
 *
 * The key is derived from the wallet rather than stored, so the transcript is
 * protected by the password rather than by file permissions, and a locked
 * wallet cannot read its own history. That also means history belongs to an
 * identity: restore a different phrase and the old transcripts stay closed.
 *
 * ## Why an append-only log
 *
 * It is what this stack already is. Turns arrive in order and are never edited,
 * which is exactly a Hypercore, and it leaves the door open to replicating a
 * transcript between someone's own devices later. Deletion is a tombstone
 * rather than a truncation, because a log cannot forget its middle.
 */

export type Record =
  | {
      readonly kind: 'turn'
      readonly conversation: string
      readonly role: 'you' | 'model'
      readonly text: string
      readonly model: string
      readonly jobId: string | null
      readonly at: number
    }
  | {
      readonly kind: 'opened'
      readonly conversation: string
      readonly model: string
      readonly at: number
    }
  | { readonly kind: 'deleted'; readonly conversation: string; readonly at: number }

export interface Turn {
  readonly role: 'you' | 'model'
  readonly text: string
  readonly jobId: string | null
  readonly at: number
}

export interface Transcript {
  readonly id: string
  readonly model: string
  readonly at: number
  readonly turns: readonly Turn[]
}

/** One matching turn, carrying enough of its conversation to be shown on its own. */
export interface Match {
  readonly conversation: string
  readonly model: string
  readonly role: 'you' | 'model'
  readonly text: string
  readonly jobId: string | null
  readonly at: number
}

/** A log this can append to and read back. Injected, so it is testable without Corestore. */
export interface Log {
  append(record: Record): Promise<void>
  read(): Promise<readonly Record[]>
}

export class History {
  readonly #log: Log

  constructor(log: Log) {
    this.#log = log
  }

  async opened(conversation: string, model: string): Promise<void> {
    await this.#log.append({ kind: 'opened', conversation, model, at: Date.now() })
  }

  async said(
    conversation: string,
    model: string,
    role: 'you' | 'model',
    text: string,
    jobId: string | null = null
  ): Promise<void> {
    await this.#log.append({ kind: 'turn', conversation, role, text, model, jobId, at: Date.now() })
  }

  async deleted(conversation: string): Promise<void> {
    await this.#log.append({ kind: 'deleted', conversation, at: Date.now() })
  }

  /**
   * Every conversation still standing, newest first.
   *
   * Rebuilt from the log each time rather than cached, because the log is the
   * truth and a cache that drifts from it would show someone a conversation
   * they deleted.
   */
  async transcripts(): Promise<readonly Transcript[]> {
    const byId = new globalThis.Map<string, { model: string; at: number; turns: Turn[] }>()

    for (const record of await this.#log.read()) {
      // A kind this version does not know is skipped rather than folded in. It
      // used to fall through to the branch below and create the conversation
      // with `model: undefined`, which every real turn afterwards then joined —
      // so one record from a newer release left a whole conversation listed as
      // `undefined` and unable to be continued. This log is meant to replicate
      // between one person's own devices, which makes that the expected case
      // rather than a hypothetical.
      if (record.kind !== 'opened' && record.kind !== 'turn' && record.kind !== 'deleted') {
        continue
      }

      // Everything before a tombstone is forgotten, and anything after it
      // starts a new conversation that happens to reuse the id.
      if (record.kind === 'deleted') {
        byId.delete(record.conversation)
        continue
      }

      const existing = byId.get(record.conversation)
      if (!existing) {
        byId.set(record.conversation, {
          model: record.model,
          at: record.at,
          turns: record.kind === 'turn' ? [toTurn(record)] : []
        })
        continue
      }

      // Taken from whichever record carries one rather than only the first, so
      // a conversation whose opening record was lost or skipped still knows
      // what it was talking to.
      if (typeof existing.model !== 'string' && typeof record.model === 'string') {
        existing.model = record.model
      }

      if (record.kind === 'turn') existing.turns.push(toTurn(record))
    }

    return [...byId.entries()]
      .map(([id, value]) => ({ id, model: value.model, at: value.at, turns: value.turns }))
      .filter((transcript) => transcript.turns.length > 0)
      .sort((a, b) => lastAt(b) - lastAt(a))
  }

  /**
   * Turns containing `query`, newest first.
   *
   * Built on `transcripts()` rather than reading the log directly, so a deleted
   * conversation cannot be found by searching for it — a tombstone that hides a
   * transcript from the list but not from search would be worse than no
   * deletion at all.
   *
   * Substring rather than tokens or ranking. A prompt is not a document
   * collection, the whole corpus is one person's own turns, and matching what
   * they typed is what they expect. Anything cleverer is a decision to make
   * when the log is big enough to need it.
   */
  async search(query: string, limit = 100): Promise<readonly Match[]> {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []

    const matches: Match[] = []

    for (const transcript of await this.transcripts()) {
      for (const turn of transcript.turns) {
        if (!turn.text.toLowerCase().includes(needle)) continue
        matches.push({
          conversation: transcript.id,
          model: transcript.model,
          role: turn.role,
          text: turn.text,
          jobId: turn.jobId,
          at: turn.at
        })
      }
    }

    return matches.sort((a, b) => b.at - a.at).slice(0, limit)
  }
}

/**
 * The earlier turns of a conversation, folded into the next prompt.
 *
 * A job carries one prompt and nothing else — the worker runs the model on
 * exactly what was submitted — so without this a "conversation" is a column of
 * unrelated questions that only looks like one because they are drawn under
 * each other. Tell it your name in the first turn and it cannot answer for it
 * in the second.
 *
 * There is no disclosure to weigh of the kind room context has: these are the
 * same person's own turns with the same model, and the only thing reaching the
 * worker is what that worker already answered.
 *
 * Oldest dropped first when the budget bites, because the last exchange is
 * nearly always what the next question is about. The budget is in characters
 * rather than turns: ten one-word replies and ten essays are not the same
 * thing to pay for.
 */
export function withHistory(turns: readonly Turn[], prompt: string, budget = 6000): string {
  const lines: string[] = []
  let left = budget

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (typeof turn?.text !== 'string' || turn.text.trim() === '') continue

    const line = `${turn.role === 'you' ? 'User' : 'Assistant'}: ${turn.text}`
    if (line.length > left) break
    left -= line.length
    lines.unshift(line)
  }

  if (lines.length === 0) return prompt

  return [
    'This is an ongoing conversation between you and the user, for context.',
    '',
    ...lines,
    '',
    'Continue it. Answer the following:',
    prompt
  ].join('\n')
}

function toTurn(record: Extract<Record, { kind: 'turn' }>): Turn {
  return { role: record.role, text: record.text, jobId: record.jobId, at: record.at }
}

/** Ordered by the most recent thing said, not by when it started. */
function lastAt(transcript: Transcript): number {
  return transcript.turns.at(-1)?.at ?? transcript.at
}
