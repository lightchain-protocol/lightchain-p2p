/**
 * The markup this panel drives, and the twelve things that change as somebody
 * uses it.
 *
 * The record is called `ui` rather than `state`, and the fields keep the names
 * they had — they are read from six files now, and a shared record is the only
 * honest way to say that an exported `let` cannot be reassigned by an importer.
 */

export const ai = {
  list: document.getElementById('model-list'),
  past: document.getElementById('conversation-list'),
  pastTitle: document.getElementById('past-title'),
  head: document.getElementById('ai-head'),
  model: document.getElementById('ai-model'),
  session: document.getElementById('ai-session'),
  body: document.getElementById('ai-body'),
  empty: document.getElementById('ai-empty'),
  state: document.getElementById('ai-state'),
  phase: document.getElementById('ai-phase-text'),
  dots: document.getElementById('ai-dots'),
  stateBody: document.getElementById('ai-state-body'),
  stateHint: document.getElementById('ai-state-hint'),
  messages: document.getElementById('ai-messages'),
  foot: document.getElementById('ai-foot'),
  composer: document.getElementById('ai-composer'),
  prompt: document.getElementById('ai-prompt'),
  send: document.getElementById('ai-send'),
  cancel: document.getElementById('ai-cancel'),
  end: document.getElementById('ai-end'),
  close: document.getElementById('ai-close'),
  forget: document.getElementById('ai-forget')
}

/** What changes as somebody works in this panel. */
export const ui = {
  /** The published list, as last fetched. */
  models: [],
  /** The fetch in flight, so two callers share one round trip. */
  modelsLoaded: null,
  /** The model a session is open against, if any. */
  openModel: null,
  /** The answer arriving now, if one is. */
  streaming: null,
  /** Whether a stop has been asked for and not yet landed. */
  stopping: false,
  /** Past conversations, as last read. */
  conversations: [],
  /** The transcript being read back, by id. */
  viewing: null,
  /** Why the last attempt to open a session failed. */
  startFailure: null,
  /** Why the last question failed. */
  sendFailure: null,
  /** What the funding notice should say, if anything. */
  funding: null,
  /** What has to be paid in before anything can be asked, if anything. */
  gate: null,
  /** The job the question in flight belongs to. */
  askingJobId: null,
  /** What the model list is filtered to. */
  filter: ''
}
