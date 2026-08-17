# @lcai-p2p/preflight

Decides whether a host can run a Lightchain worker, and says what to do when it
cannot.

## Why this exists

The existing worker toolkit documents **sixteen named failure modes** and detects
none of them. It also publishes hardware requirements — 8 GB of VRAM, 50 GB of
disk, specific Docker versions — that no script ever checks.

The result is that an operator meets those failures as opaque errors several
phases into onboarding, or worse, after the worker has started, accepted a job
and lost it. A GPU that is 2 GB short produces a container that runs perfectly
until the first inference.

Everything checkable is checked here, before anything is installed.

## Pure by design

This package performs no I/O. It takes observations and returns verdicts:

```ts
import { runChecks, isReady } from '@lcai-p2p/preflight'

const results = runChecks({
  docker: { cliPresent: true, daemonRunning: false },
  ollama: { reachable: true, models: ['llama3:8b'] },
  gpu: { detected: true, name: 'RTX 4070', vramBytes: 12 * GIB }
})
```

Probing a host is I/O and lives in the application. Deciding whether a host is
fit is judgement, and putting it here means it can be tested exhaustively
without a GPU, a Docker daemon or a network. Every branch below is covered by a
test.

## The judgements worth knowing about

**A Docker CLI that exists tells you nothing.** `docker --version` answers from
the CLI alone. Only asking for the _server_ version distinguishes "installed"
from "running", and a stopped daemon is the single most common way onboarding
fails.

**Ollama model naming is subtle enough to deserve three outcomes.** `/api/tags`
reports `llama3-8b:latest`, while `SUPPORTED_MODELS` says `llama3-8b`, and the
upstream pull is `llama3:8b`. So:

| Ollama has         | Verdict           | Why                                                                                                  |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `llama3-8b`        | pass              | exact match                                                                                          |
| `llama3-8b:latest` | pass, with a note | works, but the worker logs a scary-looking verification warning at startup                           |
| `llama3:8b` only   | **fail**          | the alias was never created, so queued jobs cannot resolve and you get an opaque model hash mismatch |

That middle row matters: the benign warning is reliably reported as a fault, and
saying so up front is cheaper than answering it later.

**Failures and warnings are different things.** A warning never blocks a worker
from starting. Low RAM degrades performance; insufficient VRAM prevents
inference entirely. Unreadable VRAM is a warning, not a failure — refusing to
start over a number we could not read would be worse than saying we could not
read it.

**An unprobed host warns rather than passing.** A check that did not run must
never look like a check that succeeded.

**Apple silicon has no discrete VRAM**, since the GPU shares system memory, so
the VRAM floor does not apply and is not enforced against it.

## Every non-pass carries a remedy

A verdict with no action attached is just a louder error. There is a test
asserting that no failure or warning can ship without one, and the remedies name
the specific command — `ollama cp llama3:8b llama3-8b`, not "configure Ollama".

The Foundry check blames the shell rather than the install, because a fresh
Foundry install almost always looks missing until the terminal is reopened.
