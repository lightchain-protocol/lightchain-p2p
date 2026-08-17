# @lcai-p2p/worker

Network profiles, configuration and Docker orchestration for a Lightchain
worker. This is Advancement 2 — collapsing a nine-phase manual onboarding into
something an operator can run.

## Pure by design

No I/O. It turns configuration into argument vectors and `docker inspect` output
into verdicts, so every flag and every state transition is asserted in tests
without Docker installed. Execution lives in `apps/supervisor`.

```ts
import { resolveConfig, runWorker, parseContainerState } from '@lcai-p2p/worker'

const config = resolveConfig({
  keysDir: '/home/op/lightchain-worker/keys',
  keystorePassword: process.env.WORKER_PASSWORD,
  aiConfigAddress: '0x24D1…',
  jobRegistryAddress: '0xfB15…',
  platform: os.platform()
})

const cmd = runWorker(config, keystoreFile)
console.log(cmd.display) // safe to log: secrets are redacted
spawn('docker', cmd.argv) // the real thing
```

## Secrets never reach a log

Every command carries two forms. `argv` has the real values; `display` has the
keystore password and private key replaced with `<redacted>`.

This exists because the toolkit interpolates secrets into shell strings, which
is exactly how an operator ends up pasting a private key into a support channel.
There are tests asserting that no command's `display` can contain either secret.

## Configuration is rejected early or not at all

Each of these is something the toolkit accepts and the operator discovers much
later, usually as a container that starts and then misbehaves.

**A tagged model name is refused.** The worker computes `keccak256` of the
`SUPPORTED_MODELS` string and matches incoming jobs on that hash. `llama3-8b:latest`
hashes differently from `llama3-8b`, so every job silently fails to resolve and
reports as a model hash mismatch. The toolkit's own config file warns about this
in a comment; here it is a validation error.

**An empty keystore password is refused.** The toolkit ships a placeholder and
expects it to be replaced. Left as-is, the keystore cannot be unlocked and the
failure appears at registration.

**Chain ID, RPC and image travel together.** Selecting a network sets all of
them, so a testnet image cannot be pointed at mainnet RPC.

**Running requires resolved registry addresses.** `runWorker` throws rather than
starting a container that will fail once it needs `AIConfig`.

## The Windows Ollama address

On Windows, `host.docker.internal` resolves IPv6-first and Go's HTTP client
sticks to the IPv6 address, so requests to Ollama **hang rather than fail** — the
worker looks healthy and simply never completes inference.

`defaultOllamaUrl` returns Docker Desktop's IPv4 gateway on `win32` and the
hostname elsewhere. The toolkit documents this fix in a comment and its script
does not apply it, so it is applied here rather than left to configuration.

## A running container is not a working one

`--restart always` means a broken worker still shows as up: `docker ps` is happy
while the container crashes and restarts every few seconds, taking no jobs.

`parseContainerState` distinguishes:

| Health         | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `running`      | up, and not thrashing                                            |
| `restart-loop` | up by every casual measure, restarting repeatedly, doing nothing |
| `stopped`      | exists, exited cleanly                                           |
| `exited-error` | exited non-zero                                                  |
| `absent`       | no container, or output we could not parse                       |

A restart loop is almost always a bad keystore password, a chain ID that does
not match the network, or an unreachable RPC endpoint, and the remedy says so. A
couple of restarts is tolerated rather than reported as a loop.

## Registration is orchestrated, not reimplemented

The staking call lives in the image's Go binary, which reads
`AIConfig.minimumStake()` and calls `WorkerRegistry.register`. We invoke that
binary rather than making the contract call ourselves, so the stake logic has
one definition instead of two that can drift.
