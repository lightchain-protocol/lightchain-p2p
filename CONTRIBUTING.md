# Contributing

## Branches and commits

```bash
git checkout -b feat/short-description
git checkout -b fix/short-description
git checkout -b docs/short-description
git checkout -b chore/short-description
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: stream model weights into the runtime with range requests
fix: reseed drives after fetch instead of joining client-only
```

Rebase on `main`, squash on merge. One feature per commit in `main`'s history.

### Commit authorship

`pnpm install` points `core.hooksPath` at `.githooks`, which strips the
`Co-authored-by: Cursor` trailer some editors inject. Without it, commits land
attributed to a bot account instead of the person who wrote them.

Check your identity resolves to the right GitHub account before your first
commit, because attribution is by email and a mismatch is invisible locally:

```bash
git config user.email          # must be verified on your GitHub account
git log -1 --format='%an <%ae>'
```

If `.git/config` is ever reset, `pnpm install` restores the hook path.

## The rules that matter

Three conventions here are not style preferences. Breaking them causes damage
that cannot be undone or is expensive to find.

### 1. Apps never import Pear modules directly

Anything touching Hypercore, Hyperdrive, Autobase, blind peering or
`sodium-native` lives in `packages/`. Applications compose packages.

This keeps native addons out of the Electron renderer, where they cannot load
under sandboxing, and it keeps the two engineering tracks from reaching into
each other's code. It is enforced by lint, not just by convention.

The exception is `apps/*/workers/**`, which is Bare worker code and is
explicitly allowed to use the stack.

### 2. Schemas are additive-only, forever

Hypercore and Autobase blocks are signed and replicated permanently. They
cannot be migrated later. When changing anything in `packages/protocol`:

- Add optional fields. Never remove one, never renumber one, never change a
  type.
- Both track owners must review. This is why `packages/protocol` is in
  CODEOWNERS twice.

A schema mistake is not a bug you fix in the next release. It is in the log
forever.

### 3. Classify every constant you touch

Anything denominated in blocks, slots or epochs changes meaning when block time
changes. Anything in seconds does not. The pull request template asks you to
state which, because getting this wrong is silent — the code keeps working and
just means something different.

## Testing

A unit test is not sufficient for anything that replicates. Availability bugs
only appear when the publisher goes offline, so the bar for `packages/drive`,
`packages/da` and `packages/blind` is a **two-machine test** using
`packages/testkit`, with the publisher offline for part of the run.

## Before opening a pull request

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Document any new environment variable in the package README and in
`.env.example`.
