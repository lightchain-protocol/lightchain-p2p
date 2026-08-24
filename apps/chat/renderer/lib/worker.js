/**
 * Running a worker, as a checklist rather than a riddle.
 *
 * Six steps, each of which says where you are and what one press does next:
 * host ready, models, worker key, stake, register, run. The panel reports
 * rather than diagnoses — a check that fails carries the remedy, a shortfall
 * carries the exact amount, and an error lands inline on the step it belongs to
 * rather than in a toast floating over the content.
 *
 * Where a failure has a fix this application can perform, it offers to perform
 * it rather than printing the command: start Docker, start Ollama, download a
 * model, fund the key from this app's wallet. The published guide is nine
 * phases of terminal, and every one of them that could be a button is one.
 *
 * Honesty boundary, kept deliberately: nothing here replaces the GPU, the
 * stake, or the decision about which models to serve. Installing Docker or
 * Ollama opens their download — an application that silently installed system
 * software would be a worse thing than a link. And no model is named here: the
 * whitelist is the network's, read live, because mainnet publishes one and
 * devnet ten and governance moves both.
 *
 * Everything this file writes is machine-generated — a probe's observation, a
 * container name, docker's own words — so all of it is set with textContent.
 * None of it is ever assigned as markup.
 *
 * ## What is left in this file
 *
 * Three entry points and nothing else. Each part of the surface is a file under
 * `worker/`: the markup and the four things that change, how it says things, the
 * six steps, the container, the actions, the controls, and the repaint that
 * reads the worker and draws all of it.
 */

// Imported for its side effect: it wires the refresh button, the model fetch,
// the copy controls, the two key forms and the four Docker verbs at load.
import './worker/controls.js'

export { appendWorkerOutput, refreshWorker, setWorkerBusy } from './worker/refresh.js'
