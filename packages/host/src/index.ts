export { DOCKER_DOWNLOAD_URL, startDocker } from './docker.js'

export {
  OLLAMA_DOWNLOAD_URL,
  aliasModel,
  hasModel,
  modelCandidates,
  pullModel,
  startOllama,
  type HostCommand
} from './ollama.js'

export {
  parseAppleChip,
  parseCast,
  parseDf,
  parseDocker,
  parseNvidiaSmi,
  parseOllamaTags,
  parseOllamaVersion,
  parseWindowsFree,
  plainText
} from './parse.js'

export { output, outputAsync, run, runAsync, type CommandResult, type RunOptions } from './run.js'

export {
  hostPlatform,
  probeAll,
  probeCast,
  probeDisk,
  probeDocker,
  probeGpu,
  probeMemory,
  probeOllama,
  probeOllamaCli,
  type ProbeOptions
} from './probes.js'
