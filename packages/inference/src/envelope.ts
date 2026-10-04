/**
 * The answer inside a mainnet `complete` frame.
 *
 * Mainnet workers now stream the answer in unsigned pieces and then send the
 * whole of it once more, signed, as the payload of `complete`. That payload
 * can be wrapped: `{"v":2,"answer":"…","searchContext":[…]}` when the worker
 * searched before answering. The text is `answer`; anything that is not that
 * exact shape is the answer as written, so a model that happens to reply in
 * JSON is shown its JSON.
 */
export function unwrapResponseEnvelope(text: string): string {
  if (!text.startsWith('{')) return text
  try {
    const parsed = JSON.parse(text) as { v?: unknown; answer?: unknown; searchContext?: unknown }
    return parsed?.v === 2 &&
      typeof parsed.answer === 'string' &&
      Array.isArray(parsed.searchContext)
      ? parsed.answer
      : text
  } catch {
    return text
  }
}
