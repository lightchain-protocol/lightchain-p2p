/**
 * Driving Ollama, rather than telling somebody to go and drive it.
 *
 * The published worker guide spends a whole phase on this — install the
 * runtime, `ollama pull llama3:8b`, then `ollama cp llama3:8b llama3-8b` — and
 * the copy is the part that gets missed, because nothing explains that the name
 * the worker resolves jobs against is an alias the operator has to make.
 * A checklist that prints those two commands has moved the terminal into the
 * application without removing it.
 *
 * So this is the pure half of running them for people: which registry
 * references a network's model name might be published under, which commands
 * fetch and name it, and how the runtime is started on each platform.
 * Everything here is a decision about argv, which means it can be tested on a
 * machine with no Ollama installed at all. `probes.ts` runs them.
 *
 * Deliberately no table of model names. Which models exist is the network's
 * answer, not this package's — mainnet has gone from two to seven without this
 * file changing — and a list compiled here would be wrong the first time
 * governance changed one. What is encoded is the *convention* those names
 * follow, which is a much smaller and much longer-lived thing to know.
 *
 * That convention includes the colon: `gpt-oss:20b` and `gemma4:e2b` are the
 * network's own spelling, hashed as written, and are passed through whole.
 */

/** A command as argv, never as a shell string. */
export interface HostCommand {
  readonly file: string
  readonly args: readonly string[]
  /** Safe to print above the output it produces. */
  readonly display: string
}

function command(file: string, args: readonly string[]): HostCommand {
  return { file, args, display: [file, ...args].join(' ') }
}

/** Where a person is sent when the runtime is not installed at all. */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

/** A trailing parameter count: the `8b` of `llama3-8b`, the `1.5b` of a small one. */
const PARAMETER_SIZE = /^(.+)-(\d+(?:\.\d+)?b)$/i

/**
 * The registry references a network model name might be published under, best
 * guess first.
 *
 * The network names a model `llama3-8b` and Ollama's registry names the same
 * thing `llama3:8b`. That is a convention rather than a rule, and the two
 * disagree in more than one way across a real whitelist — `deepseek-r1-32b` and
 * `qwen2.5-coder-7b` split at the parameter count, `glm-4.7-flash` at a variant
 * word, and a bare `mistral` does not split at all. Nothing on chain records
 * which, because the chain stores `keccak256` of the name and never the name.
 *
 * So this offers candidates rather than an answer, and the caller tries them in
 * order until a pull succeeds. Guessing once and failing would put an operator
 * back in a terminal working out what to type, which is the whole thing being
 * removed here. A table of known names would do the same the first time
 * governance whitelisted a model published after this build.
 */
export function modelCandidates(name: string): readonly string[] {
  // Already a reference. The worker would refuse this name anyway — it hashes
  // the plain name to match jobs — but that is `resolveConfig`'s refusal to
  // make, not a reason to mangle it here.
  if (name.includes(':')) return [name]

  const sized = PARAMETER_SIZE.exec(name)
  if (sized) return [`${sized[1]}:${sized[2]}`.toLowerCase(), name]

  const cut = name.lastIndexOf('-')
  // A variant suffix rather than a size: `glm-4.7-flash` is `glm-4.7:flash`.
  // Tried second, because a name that is genuinely hyphenated — `deepseek-r1` —
  // is published whole and splitting it would be the wrong guess.
  if (cut > 0) return [name, `${name.slice(0, cut)}:${name.slice(cut + 1)}`]

  return [name]
}

/** Fetches one registry reference. Several gigabytes, and it says so as it goes. */
export function pullModel(reference: string): HostCommand {
  return command('ollama', ['pull', reference])
}

/**
 * Names a pulled reference as the network knows it.
 *
 * The half that gets missed, and the half that fails silently: the worker looks
 * a model up by `keccak256` of the network's exact name, so a model pulled and
 * left under its registry reference is a model the worker cannot find. Nothing
 * errors — it starts, takes work, and resolves none of it.
 *
 * Null when the reference already is the name, which needs no copy.
 */
export function aliasModel(reference: string, name: string): HostCommand | null {
  return reference === name ? null : command('ollama', ['cp', reference, name])
}

/**
 * Starting the runtime, where the platform gives us a way to.
 *
 * Deliberately not `ollama serve`. That command does not exit, so anything
 * awaiting it waits forever, and a server owned by this application's process
 * tree dies with it — a worker would stop answering the moment somebody quit
 * the window. Each of these hands the job to the platform's own supervisor
 * instead and returns immediately.
 *
 * Null where we have no such handle, which is answered with instructions rather
 * than a button that lies.
 */
export function startOllama(platform: string): HostCommand | null {
  if (platform === 'darwin') return command('open', ['-a', 'Ollama'])
  // The Linux installer registers a user service; a system-wide unit needs a
  // password we will not ask for, and the failure says so.
  if (platform === 'linux') return command('systemctl', ['--user', 'start', 'ollama'])
  return null
}

/**
 * Whether Ollama already holds a model under the name the worker needs.
 *
 * `/api/tags` reports what a pull left behind, which is the reference and not
 * the network's name — and it appends `:latest` to anything untagged, so the
 * name `llama3-8b` comes back as `llama3-8b:latest`. Both count: the worker
 * resolves either.
 */
export function hasModel(tags: readonly string[], name: string): boolean {
  return tags.includes(name) || tags.includes(`${name}:latest`)
}
