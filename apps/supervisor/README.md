# lcai-supervisor

Installs, registers, supervises and updates a Lightchain worker. A single
self-contained binary per platform: the operator installs no Node, no Bare and
no Pear CLI.

This replaces a nine-phase manual onboarding. It does **not** replace the worker
— that is Go in a container, and Docker, Ollama, a GPU with at least 8 GB of
VRAM and the LCAI stake all remain requirements.

## Commands

```
lcai-supervisor doctor       check whether this host can run a worker
lcai-supervisor pull         fetch the worker image
lcai-supervisor import-key   import a private key into a keystore (stdin only)
lcai-supervisor keygen       generate the ECDH encryption key
lcai-supervisor register     register on chain and stake
lcai-supervisor start        run the worker
lcai-supervisor status       report what the container is actually doing
lcai-supervisor stop         remove the container
lcai-supervisor logs         recent worker output
```

Start with `doctor`. It checks everything checkable before anything is
installed, and every failure carries the command that fixes it.

## Configuration

Read from the environment, using the same names as the existing worker toolkit
so a current setup keeps working.

| Variable               | Default                       |
| ---------------------- | ----------------------------- |
| `NETWORK`              | `mainnet`                     |
| `WORKER_PASSWORD`      | required                      |
| `KEYS_DIR`             | `~/lightchain-worker/keys`    |
| `AI_CONFIG_ADDRESS`    | required to `start`           |
| `JOB_REGISTRY_ADDRESS` | required to `start`           |
| `SUPPORTED_MODELS`     | `llama3-8b`                   |
| `OLLAMA_URL`           | platform-dependent, see below |
| `CONTAINER_NAME`       | `lightchain-worker`           |

Selecting a network sets the chain ID, RPC, beacon, gateway and image together,
so a testnet image cannot be pointed at mainnet RPC.

## Secrets

**The private key is read from stdin and nowhere else.**

```bash
cat key.txt | lcai-supervisor import-key
```

Not a flag, because arguments are visible in process listings. Not an
environment variable, because those are inherited by every child process and
readable from `/proc`. It is handed to the container once and never written
anywhere by the supervisor.

Every Docker command the supervisor prints has secrets replaced with
`<redacted>`, so pasting output into a support channel is safe.

**The keystore password is still an environment variable**, matching the
toolkit's `secrets.env` convention. That is a deliberate interim position rather
than the end state: the worker must survive unattended restarts, so the password
has to be retrievable without a human, and Bare has no OS keychain binding today.
A protected file or platform keychain would be better and is not yet built.

## Things it gets right that are easy to get wrong

**A running container is not a working one.** `--restart always` means a broken
worker still shows as up while crashing every few seconds and taking no jobs.
`status` distinguishes `running` from `restart-loop` and names the three usual
causes.

**It refuses to guess between keystores.** With two keys imported, picking one
arbitrarily would run the worker under an address the operator did not intend —
it would register, take jobs and earn to the wrong account with nothing looking
wrong. Pass `--address` when more than one exists.

**Windows reaches Ollama over IPv4.** `host.docker.internal` resolves IPv6-first
there and Go's HTTP client sticks to it, so inference hangs rather than fails
while the worker looks healthy. The supervisor uses Docker Desktop's IPv4
gateway on Windows automatically.

**A tagged model name is rejected.** The worker matches jobs on `keccak256` of
the `SUPPORTED_MODELS` string, so `llama3-8b:latest` silently resolves nothing.

## Not yet wired

Contract address resolution. `AI_CONFIG_ADDRESS` and `JOB_REGISTRY_ADDRESS` must
be supplied, where the toolkit reads them from the registry with `aiConfig()`
and `jobRegistry()`. Until that is built, resolve them once with `cast` and set
them in the environment.
