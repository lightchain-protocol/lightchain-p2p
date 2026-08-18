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

      if (record.kind === 'turn') existing.turns.push(toTurn(record))
    }

    return [...byId.entries()]
      .map(([id, value]) => ({ id, model: value.model, at: value.at, turns: value.turns }))
      .filter((transcript) => transcript.turns.length > 0)
      .sort((a, b) => lastAt(b) - lastAt(a))
  }
}

function toTurn(record: Extract<Record, { kind: 'turn' }>): Turn {
  return { role: record.role, text: record.text, jobId: record.jobId, at: record.at }
}

/** Ordered by the most recent thing said, not by when it started. */
function lastAt(transcript: Transcript): number {
  return transcript.turns.at(-1)?.at ?? transcript.at
}
