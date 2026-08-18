# @lcai-p2p/host

Looking at the machine the software is running on: what is installed, what is
running, and what the commands said.

Two applications need this. `apps/supervisor` asks before it installs anything,
and `apps/chat` asks so its Worker panel can say whether this host could run
one. It lives here so there is one definition rather than two that drift.

## The split that makes it testable

I/O in `probes.ts` and `run.ts`; interpretation in `parse.ts`. Every function in
`parse.ts` is pure, so an Apple GPU, a stopped Docker daemon, a multi-GPU host
and a full disk are all reachable from a test on a laptop that has none of them.

That mirrors [`@lcai-p2p/preflight`](../preflight), which holds the judgement
about whether a host is good enough. Three layers, each testable alone:

```
host/parse      what the output means
host/probes     asking the machine
preflight       whether the answer is good enough
```

## Nothing blocks

`runAsync` is the one to use. `run` exists because a terminal has nothing else
to do while it waits, but the desktop worker is replicating rooms on the same
thread — a synchronous `nvidia-smi` stalls the conversation, and `docker pull`
would freeze it for minutes.

`probeAll` runs its probes in parallel, since they are independent and running
them in sequence makes every user wait for the slowest.

## Failing soft is deliberate

A probe that throws returns `undefined`, which preflight reports as "not probed"
— a warning, not a verdict. **A host we cannot read is not the same as a host
that cannot work**, and reporting the first as the second sends operators to fix
imaginary problems.

The same reasoning runs through the parsers. `parseDf` returns `undefined`
rather than `0` when it cannot find a number, because zero free bytes reads as a
full disk and fails the check.

## One runtime, one source

`child_process` and `os` resolve to `bare-subprocess` and `bare-os` under Bare,
and to Node's own elsewhere, through the `imports` map in `package.json`. Bare
honours that map; Node only consults `imports` for `#`-prefixed specifiers and
so ignores it.
