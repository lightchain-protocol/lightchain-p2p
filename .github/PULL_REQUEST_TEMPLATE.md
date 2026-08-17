## Summary

<!-- What changed and why. One or two sentences. -->

## Type

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] chore
- [ ] refactor

## Units and timing

Answer both. Most incidents in this codebase come from getting these wrong.

- [ ] No constant I touched is denominated in blocks, slots or epochs — or if it is, I state its wall-clock meaning below
- [ ] No encoding or schema changed — or if it did, the change is additive-only and I explain why below

<!-- Explain here if either box needed qualifying. -->

## Test plan

- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] Unit tests added or updated
- [ ] For anything touching replication: a two-machine test, with the publisher offline for part of it
- [ ] Ran on: <!-- Windows / macOS / Linux -->

## Release safety

- [ ] Safe to merge before the next release
- [ ] Must ship together with: <!-- name the dependency -->
