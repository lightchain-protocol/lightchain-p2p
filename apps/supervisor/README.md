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
lcai-supervisor set-password store the keystore password (stdin only)
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
| `WORKER_PASSWORD`      | fallback for `set-password`   |
| `KEYS_DIR`             | `~/lightchain-worker/keys`    |
| `AI_CONFIG_ADDRESS`    | read from the registry        |
| `JOB_REGISTRY_ADDRESS` | read from the registry        |
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
readable from `/proc`.

It is never given to Docker at all. The image's own `import-key` takes
`--private-key <hex>`, which would put the key in the host's process table for
the life of that container, so the supervisor writes the Keystore V3 file itself
and hands the worker only the finished file.

Every Docker command the supervisor prints has secrets replaced with
`<redacted>`, so pasting output into a support channel is safe.

**The keystore password is read from a protected file.**

```bash
cat password.txt | lcai-supervisor set-password
```

It is written to `<KEYS_DIR>/keystore-password` with mode `0600`. `WORKER_PASSWORD`
still works if no file exists, so an existing `secrets.env` setup keeps running,
but the file wins when both are present — otherwise setting one would look like
it had closed the exposure while the variable quietly kept being used.

### What that does and does not protect

The worker restarts unattended, so the password has to be readable by a machine
with nobody at the keyboard. Nothing in that situation can be protected by a
passphrase: whatever the machine can read on its own, anyone with the machine's
access can read too. This is a permission boundary, not a cryptographic one.

It removes the environment variable, which is worth doing on its own — variables
are inherited by every child process, readable from `/proc/<pid>/environ` by the
same user, and end up in shell history, `docker inspect` output and CI logs.

It does not protect against root, against the operator's own account being
compromised, or against a stolen disk or backup. On Windows the mode is
advisory, since NTFS uses ACLs, so the file inherits the directory's permissions
and this is worth less there.

**The password still reaches the container as an environment variable.**
`WORKER_KEYSTORE_PASSWORD` is the only form the image accepts, so it is visible
in `docker inspect` for as long as the container exists. Closing that needs a
change to the image, not to the supervisor.

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

## Contract addresses

`start` reads `AI_CONFIG_ADDRESS` and `JOB_REGISTRY_ADDRESS` from the
`WorkerRegistry` with `aiConfig()` and `jobRegistry()`, one round trip before
the container is created. Nothing needs setting.

Setting either by hand still wins, which is the escape hatch for a deployment
the registry does not know about. If the registry cannot be reached and neither
is set, `start` fails and says so rather than launching against defaults — a
worker running on the wrong contracts accepts jobs it cannot settle.
