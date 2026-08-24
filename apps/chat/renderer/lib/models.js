/**
 * The published models, the sessions opened against them, and the transcripts
 * left behind.
 *
 * The list is also what the composer matches `@name` against, so it is fetched
 * on demand rather than only when this panel is opened.
 *
 * ## Where a failure goes
 *
 * Into an alert, in the column the failure happened in, and nowhere else. This
 * panel used to assign `err.message` to `#ai-session` — the line under the
 * model's name — so `Call JobRegistry.setDelegateAuthorization(delegate, true)
 * first` rendered in muted grey and read as a description of the model. The
 * same slot at the foot of the model list did the same thing for the funding
 * note. Three named slots exist now, none of them is a caption, and
 * `#ai-session` carries session facts only.
 *
 * ## What is left in this file
 *
 * The seven entry points and nothing else. Each part is a file under `models/`:
 * the markup and what changes, how it says things, a turn, the registry, the
 * list, the history, a live session, and the controls.
 */

// Imported for its side effect: it wires the filter, the composer, cancel,
// forget, end and close at load.
import './models/controls.js'

export { addressedToModel, ensureModels, listModels, refreshModels } from './models/registry.js'
export { openTranscript } from './models/history.js'
export { onAiProgress, onCommitment } from './models/session.js'
